import * as fs from 'node:fs';
import * as path from 'node:path';

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
}

interface Entry { pty: IPtyLike; info: SessionInfo; linked: boolean; diskKey?: string; existingDiskKeys?: Set<string>; }

export class SessionPool {
  private entries = new Map<string, Entry>();
  // disk `.jsonl` path → live `live-<uuid>` key, set when a new session's file is
  // written (see reconcile). Lets openExisting reuse the running live process.
  private alias = new Map<string, string>();
  constructor(private ptyFactory: PtyFactory, private opts: SessionPoolOptions) {}

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
    const name = formatTimestamp(path.basename(sessionFile));
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
    const e: Entry = { pty, info, linked: infoKey.endsWith('.jsonl'), existingDiskKeys: infoKey.endsWith('.jsonl') ? undefined : this.diskKeysForCwd(cwd) };
    // Emit events using the live entry key. For a newly-created session this is
    // `live-<uuid>`; after the session file is written it is linked to the on-disk
    // `.jsonl` path (see reconcile), and `e.info.key` is read dynamically so both
    // the live key and the disk key receive status updates.
    pty.on('data', (d: string) => this.opts.onData(e.info.key, d));
    pty.on('exit', () => {
      e.info.status = 'dead';
      this.opts.onStatus(e.info.key, 'dead');
      if (e.diskKey) this.opts.onStatus(e.diskKey, 'dead');
      this.opts.onExit(e.info.key);
    });
    this.entries.set(mapKey, e);
    this.opts.onStatus(infoKey, 'running');
    return info;
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
    const e = this.entries.get(key);
    if (!e) return;
    e.pty.kill();
    this.entries.delete(key);
    // Update status AND notify the UI that the session ended. We call onExit
    // explicitly (not only via the pty 'exit' event) so the renderer updates
    // reliably even if the killed process does not emit a clean 'exit'. The
    // pty 'exit' handler may also fire onExit — that is idempotent.
    this.opts.onStatus(key, 'dead');
    this.opts.onExit(key);
  }
  // Resolve a disk `.jsonl` key to the key of the live process that owns it.
  // A session promoted from a `live-<uuid>` process links its disk path to that
  // process via `alias`; the entry is keyed by the live key, NOT the disk path, so
  // terminating by the disk key would miss the process. Resolve first so the right
  // pty is killed and `onExit` fires for the live key (the terminal pane's key),
  // avoiding orphaned processes and ghost panes.
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
    // 仅删除 sessionsDir 内的 .jsonl 文件，防止越权删除任意文件。
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
