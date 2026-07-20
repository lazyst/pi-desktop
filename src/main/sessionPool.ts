import * as fs from 'node:fs';
import * as path from 'node:path';
import { BackpressureController } from './backpressure';

export type SessionStatus = 'running' | 'dead';
export interface SessionInfo {
  key: string;
  cwd: string;
  name: string;
  status: SessionStatus;
}
export interface SessionGroup {
  cwd: string;
  sessions: Array<{ key: string; name: string; time: string }>;
}
export interface PtyFactory {
  (file: string, args: string[], opts: { cwd: string; cols: number; rows: number; name: string }): IPtyLike;
}
export interface IPtyLike {
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  // 原生 pause/resume（node-pty IPty 接口），用于源头背压反压（对齐 VS Code ptyProcess.pause/resume）。
  pause(): void;
  resume(): void;
  on(event: 'data' | 'exit', cb: (d?: any) => void): void;
  pid?: number;
}
export interface SessionPoolOptions {
  cols: number;
  rows: number;
  sessionsDir: string;
  onData: (key: string, data: string) => void;
  onStatus: (key: string, status: SessionStatus) => void;
  onExit: (key: string) => void;
  // Live session (keyed `live-<uuid>`) promoted to a disk session: tells the
  // renderer that `from` and `to` are the same process so it can keep the same
  // terminal pane and highlight the on-disk entry.
  onRelink?: (from: string, to: string) => void;
  // 背压回传（对齐 VS Code ptyService 的 acknowledgeDataEvent）：渲染端每消费 N 字节即调用，
  // 主进程据消费进度对 PTY 做流控决策（当前 node-pty 模型下内核 PTY 缓冲已天然流控，
  // 此处记账并暴露钩子，供后续按需限制高频输出/诊断，接口语义与 VS Code 一致）。
  acknowledgeDataEvent?: (key: string, bytes: number) => void;
}

interface Entry { pty: IPtyLike; info: SessionInfo; linked: boolean; diskKey?: string; existingDiskKeys?: Set<string>; bp: BackpressureController; }

// 主进程端数据缓冲（对齐 VS Code ptyService 的 TerminalDataBufferer）：每会话 5ms 时间窗
// 聚合 pty 小块输出，窗口结束一次性 emit，避免高频小块直达渲染端造成的中间帧闪烁。
// 与渲染端 XtermTerminal 的 5ms 前端聚合构成「双段缓冲」，并统一了 IPC 投递节奏。
const DATA_BUFFER_MS = 5;
interface DataBuffer { chunks: string[]; timer: NodeJS.Timeout | null; }

export class SessionPool {
  private entries = new Map<string, Entry>();
  // disk `.jsonl` path → live `live-<uuid>` key, set when a new session's file is
  // written (see reconcile). Lets openExisting reuse the running live process.
  private alias = new Map<string, string>();
  // 每会话聚合缓冲（key 为 emit key：live key 或 disk key）。
  private dataBuffers = new Map<string, DataBuffer>();
  constructor(private ptyFactory: PtyFactory, private opts: SessionPoolOptions) {}

  /** 聚合并下发单块 pty 数据（5ms 时间窗，对齐 TerminalDataBufferer）。 */
  private emitData(key: string, data: string): void {
    let buf = this.dataBuffers.get(key);
    if (!buf) {
      buf = { chunks: [], timer: null };
      this.dataBuffers.set(key, buf);
    }
    buf.chunks.push(data);
    if (buf.timer) return; // 窗口已开，等待 flush
    buf.timer = setTimeout(() => {
      const b = this.dataBuffers.get(key);
      if (!b) return;
      const joined = b.chunks.join('');
      b.chunks = [];
      b.timer = null;
      this.dataBuffers.delete(key);
      // 经背压计数：累加未确认字符；超高水位由 BackpressureController 调 pty.pause() 源头反压。
      this.entries.get(key)?.bp.onData(joined.length);
      // 数据照常发往渲染端（pause 只掐断 PTY 后续输出，已读出的这块照发）。
      this.opts.onData(key, joined);
    }, DATA_BUFFER_MS);
  }

  openExisting(sessionFile: string): SessionInfo {
    const existing = this.entries.get(sessionFile);
    if (existing && existing.info.status === 'running') return existing.info;
    // A session created in this app (keyed `live-<uuid>`) only writes its `.jsonl`
    // after the first message. Until then the running process lives under its live
    // key; once promoted we link the disk path to that key (see reconcile). Reuse the
    // still-running live process instead of spawning a duplicate, and report the live
    // key so the renderer keeps the same terminal pane (no remount, no orphaned process).
    const liveKey = this.alias.get(sessionFile);
    const live = liveKey ? this.entries.get(liveKey) : undefined;
    if (live && live.info.status === 'running') return { ...live.info };
    const cwd = readSessionCwd(sessionFile) ?? decodeCwd(path.basename(path.dirname(sessionFile)));
    // 冷启动已有磁盘会话：用首条用户消息作为会话名（与 listFiles 一致），
    // 解析失败再回退到文件名的时间戳，避免标题区只显示时间戳。
    const name = readSessionName(sessionFile) ?? formatTimestamp(path.basename(sessionFile));
    return this.spawn(['--session', sessionFile], cwd, name, sessionFile, sessionFile);
  }
  openNew(cwd: string, name?: string, explicitKey?: string): SessionInfo {
    const key = explicitKey ?? `live-${randomUUID()}`;
    const args = name ? ['--name', name] : [];
    return this.spawn(args, cwd, name || 'new-session', key, key);
  }
  private spawn(args: string[], cwd: string, name: string, infoKey: string, mapKey: string): SessionInfo {
    const pty = this.ptyFactory('pi', args, { cwd, cols: this.opts.cols, rows: this.opts.rows, name: 'pi' });
    const info: SessionInfo = { key: infoKey, cwd, name, status: 'running' };
    const e: Entry = { pty, info, linked: infoKey.endsWith('.jsonl'), existingDiskKeys: infoKey.endsWith('.jsonl') ? undefined : this.diskKeysForCwd(cwd), bp: new BackpressureController(() => e.pty.pause(), () => e.pty.resume()) };
    // Emit events using the live entry key. For a newly-created session this is
    // `live-<uuid>`; after the session file is written it is linked to the on-disk
    // `.jsonl` path (see reconcile), and `e.info.key` is read dynamically so both
    // the live key and the disk key receive status updates.
    pty.on('data', (d: string) => this.emitData(e.info.key, d));
    pty.on('exit', (code: number | null, signal: string | null) => {
      e.info.status = 'dead';
      this.opts.onStatus(e.info.key, 'dead');
      if (e.diskKey) this.opts.onStatus(e.diskKey, 'dead');
      this.opts.onExit(e.info.key);
    });
    this.entries.set(mapKey, e);
    this.opts.onStatus(infoKey, 'running');
    return info;
  }
  private clearDataBuffer(key: string): void {
    const b = this.dataBuffers.get(key);
    if (b?.timer) clearTimeout(b.timer);
    this.dataBuffers.delete(key);
  }
  /** 背压回传（对齐 VS Code acknowledgeDataEvent 的源头流控）：渲染端每消费 N 字符即调用，
   * 本方法推进该会话的水位；水位降到低水位以下时 BackpressureController 调 pty.resume() 恢复。
   * disk key 与 live key 共享同一进程，故同时更新别名映射后驱动同一控制器。 */
  acknowledgeDataEvent(key: string, bytes: number): void {
    const live = this.liveKeyFor(key);
    const k = this.entries.has(live) ? live : key;
    this.entries.get(k)?.bp.acknowledge(Math.max(0, bytes | 0));
    this.opts.acknowledgeDataEvent?.(k, bytes);
  }
  write(key: string, data: string) { this.entries.get(key)?.pty.write(data); }
  resize(key: string, cols: number, rows: number) {
    const e = this.entries.get(key);
    // A pty may have exited between a layout change and this call (e.g. the user
    // pressed Ctrl+C to quit `pi`, then the terminal re-fit). Resizing a dead pty
    // throws "Cannot resize a pty that has already exited" and, unguarded, crashes
    // the main process. Skip dead ptys and absorb any race via try/catch.
    if (!e || e.info.status !== 'running') return;
    try { e.pty.resize(cols, rows); } catch { /* pty exited after the status check */ }
  }
  // Link freshly-written disk sessions to the live processes that created them.
  // Called whenever the filesystem watcher reports a new index. A live session
  // (keyed `live-<uuid>`) only writes its `.jsonl` after the first message, so it
  // must link to a disk session that appeared *after* it started (i.e. not one that
  // already existed in the cwd when the live session was created) — never to a
  // pre-existing session that merely shares the cwd. Among new candidates we pick
  // the newest. This way clicking the promoted sidebar entry reuses the same process
  // (openExisting) instead of spawning a duplicate, and the sidebar status dot
  // reflects the live process.
  reconcile(groups: SessionGroup[]): void {
    const disk: Array<{ key: string; cwd: string; mtime: number }> = [];
    for (const g of groups) {
      for (const s of g.sessions) {
        if (this.entries.has(s.key) || this.alias.has(s.key)) continue;
        let mtime = 0;
        try { mtime = fs.statSync(s.key).mtimeMs; } catch { /* ignore unreadable */ }
        disk.push({ key: s.key, cwd: g.cwd, mtime });
      }
    }
    disk.sort((a, b) => b.mtime - a.mtime);
    for (const [liveKey, e] of this.entries) {
      if (e.linked || e.info.status !== 'running') continue;
      // Only link to a disk session that did NOT exist when this live session started.
      const cand = disk.find(
        (d) => d.cwd === e.info.cwd && !this.alias.has(d.key) && !e.existingDiskKeys?.has(d.key),
      );
      if (!cand) continue;
      e.linked = true;
      e.diskKey = cand.key;
      this.alias.set(cand.key, liveKey);
      this.opts.onStatus(cand.key, 'running');
      this.opts.onRelink?.(liveKey, cand.key);
    }
  }
  // The `.jsonl` paths already present for `cwd` at this moment (used to ignore
  // pre-existing sessions when linking a freshly-created live session).
  private diskKeysForCwd(cwd: string): Set<string> {
    const root = this.opts.sessionsDir;
    if (!fs.existsSync(root)) return new Set();
    for (const enc of fs.readdirSync(root)) {
      const dir = path.join(root, enc);
      if (!fs.statSync(dir).isDirectory()) continue;
      const groupCwd = readGroupCwd(dir) ?? decodeCwd(enc);
      if (groupCwd !== cwd) continue;
      const keys = new Set<string>();
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) keys.add(path.join(dir, f));
      return keys;
    }
    return new Set();
  }
  terminate(key: string) {
    // 侧边栏的「终止进程」按钮传入的是磁盘 `.jsonl` key，而进程实际以
    // `live-<uuid>` 为 key 存在 entries 中（由 alias 间接关联）。必须先反查
    // 到 live key 才能命中真实进程；否则 entries.get(diskKey) 为 undefined，
    // 会静默 return（进程杀不掉、UI 无反馈）——这就是“过了一段时间后点击终止无效”的根因。
    // 注意：killAll / clearDirectory 内部直接传 live key，这里反查对它们也安全
    // （liveKeyFor 命中自身即原样返回）。
    const liveKey = this.liveKeyFor(key);
    const e = this.entries.get(liveKey);
    if (!e) return;
    // 同时清理指向该 live 进程的 alias 映射，避免悬空引用（对齐 deleteSession）。
    for (const [dk, lk] of this.alias) if (lk === liveKey) this.alias.delete(dk);
    e.pty.kill();
    this.entries.delete(liveKey);
    // 清掉该 key 的待发聚合缓冲，避免 kill 后迟到数据发往已销毁的渲染实例。
    this.clearDataBuffer(liveKey);
    this.entries.get(liveKey)?.bp.dispose();
    if (e.diskKey) { this.clearDataBuffer(e.diskKey); this.entries.get(e.diskKey)?.bp.dispose(); }
    // Update status AND notify the UI that the session ended. We call onExit
    // explicitly (not only via the pty 'exit' event) so the renderer updates
    // reliably even if the killed process does not emit a clean 'exit'. The
    // pty 'exit' handler may also fire onExit — that is idempotent.
    this.opts.onStatus(liveKey, 'dead');
    this.opts.onExit(liveKey);
  }
  // Resolve a disk `.jsonl` key to the key of the live process that owns it.
  // A session promoted from a `live-<uuid>` process links its disk path to that
  // process via `alias`; the entry is keyed by the live key, NOT the disk path, so
  // terminating by the disk key would miss the process. Resolve first so the right
  // pty is killed and `onExit` fires for the live key (the terminal pane's key),
  // avoiding orphaned processes and ghost panes.
  // 若 key 既非 live key 也无 alias 映射（例如 reconcile 因竞态/预存同名 .jsonl
  // 未能建立 alias），则返回原 key，交由调用方决定（terminate 会 miss 并安全返回，
  // deleteSession 仍会按原 key 删文件）。
  private liveKeyFor(key: string): string {
    if (this.entries.has(key)) return key;
    const linked = this.alias.get(key);
    if (linked && this.entries.has(linked)) return linked;
    return key;
  }
  deleteSession(key: string) {
    const liveKey = this.liveKeyFor(key);
    // 先终止进程（杀 pty + 触发 onStatus('dead') / onExit，渲染层据此关闭终端面板）。
    this.terminate(liveKey);
    // 该磁盘 key 此前若已“晋升”关联到某个 live 进程，清理此映射以免悬空。
    for (const [dk, lk] of this.alias) if (lk === liveKey) this.alias.delete(dk);
    if (!key.endsWith('.jsonl')) return;
    const dir = path.resolve(this.opts.sessionsDir);
    const target = path.resolve(key);
    const inside = target === dir || target.startsWith(dir + path.sep);
    if (!inside) return;
    try { fs.rmSync(target, { force: true }); } catch { /* 忽略占用 / 竞态 */ }
  }
  // 批量删除：对一组会话 key 逐个执行 deleteSession（含磁盘→live 反查与越权防护）。
  deleteMany(keys: string[]) {
    for (const k of keys) this.deleteSession(k);
  }
  // 清空目录：终止该 cwd 工作组下所有运行中的进程，并删除对应的全部 .jsonl 文件
  // （整组从侧边栏消失）。等价于“选中该组全部会话并删除”。
  clearDirectory(cwd: string) {
    // 1) 终止该 cwd 下所有运行中的进程（命中 live 与已晋升的磁盘条目）。
    for (const [k, e] of [...this.entries]) {
      if (e.info.cwd !== cwd) continue;
      for (const [dk, lk] of this.alias) if (lk === k) this.alias.delete(dk);
      this.terminate(k);
    }
    // 2) 删除该 cwd 对应的所有 .jsonl 文件（含尚未晋升、无运行进程的会话）。
    const dir = this.dirForCwd(cwd);
    if (!dir) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* 忽略占用 / 竞态 */ }
    }
    // 3) 整组删空后移除空的编码 cwd 文件夹，保持 sessionsDir 整洁。
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* 非空或被占用 */ }
  }
  // 返回某 cwd 在 sessionsDir 下的编码文件夹路径（用于清空目录时定位待删文件）。
  private dirForCwd(cwd: string): string | undefined {
    const root = this.opts.sessionsDir;
    if (!fs.existsSync(root)) return undefined;
    for (const enc of fs.readdirSync(root)) {
      const dir = path.join(root, enc);
      if (!fs.statSync(dir).isDirectory()) continue;
      const groupCwd = readGroupCwd(dir) ?? decodeCwd(enc);
      if (groupCwd === cwd) return dir;
    }
    return undefined;
  }
  killAll() { for (const k of [...this.entries.keys()]) this.terminate(k); }
  get(key: string) { return this.entries.get(key)?.info; }
  debugInfo(): { count: number; pids: number[] } {
    const running = [...this.entries.values()].filter((e) => e.info.status === 'running');
    return { count: running.length, pids: running.map((e) => e.pty.pid ?? -1).filter((p) => p > 0) };
  }
  listFiles(): SessionGroup[] {
    const root = this.opts.sessionsDir;
    if (!fs.existsSync(root)) return [];
    const groups: SessionGroup[] = [];
    for (const enc of fs.readdirSync(root)) {
      const dir = path.join(root, enc);
      if (!fs.statSync(dir).isDirectory()) continue;
      const cwd = readGroupCwd(dir) ?? decodeCwd(enc);
      const sessions = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const file = path.join(dir, f);
          const stamp = formatTimestamp(f);
          const name = readSessionName(file) ?? stamp;
          return { key: file, name, time: stamp };
        });
      groups.push({ cwd, sessions });
    }
    return groups;
  }
}

export function decodeCwd(enc: string): string {
  let s = enc;
  if (s.startsWith('--')) s = s.slice(2);
  if (s.endsWith('--')) s = s.slice(0, -2);
  // pi 的目录名编码：反斜杠 → "--"，盘符冒号被直接丢弃（D: → D）。
  s = s.replace(/--/g, '\\');
  // 还原 Windows 盘符的绝对路径："X\\" → "X:\\"。否则拿到 D\\foo 这种非法 cwd，
  // 既会在侧边栏显示为 D\\foo，也会让 spawn 启动 pi 失败。
  return s.replace(/^([A-Za-z])\\/, '$1:\\');
}
export function formatTimestamp(filename: string): string {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return filename;
  return `${m[1]} ${m[2]}:${m[3]}`;
}
function readSessionCwd(file: string): string | undefined {
  try {
    const line = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
    const obj = JSON.parse(line);
    return typeof obj?.cwd === 'string' ? obj.cwd : undefined;
  } catch { return undefined; }
}
// A session's human-friendly name is the text of its first user message.
// The .jsonl stores no explicit title, so derive it from the first user turn.
function readSessionName(file: string): string | undefined {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return undefined; }
  try {
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('utf8', 0, n);
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (obj?.type === 'message' && obj?.message?.role === 'user') {
          const c = obj.message.content;
          const str = Array.isArray(c)
            ? c.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join(' ')
            : String(c ?? '');
          const clean = str.replace(/\s+/g, ' ').trim();
          if (clean) return clean.length > 80 ? clean.slice(0, 80) : clean;
        }
      } catch { /* skip non-JSON / malformed lines */ }
    }
  } catch { /* ignore read errors (e.g. file being written) */
  } finally {
    try { fs.closeSync(fd); } catch { /* noop */ }
  }
  return undefined;
}
function readGroupCwd(dir: string): string | undefined {
  const first = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
  return first ? readSessionCwd(path.join(dir, first)) : undefined;
}
function randomUUID(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}
