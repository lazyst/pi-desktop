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
}

interface Entry { pty: IPtyLike; info: SessionInfo; }

export class SessionPool {
  private entries = new Map<string, Entry>();
  constructor(private ptyFactory: PtyFactory, private opts: SessionPoolOptions) {}

  openExisting(sessionFile: string): SessionInfo {
    // Reuse an already-running process for this session file instead of always
    // spawning a new one. Without this, switching back to a session the user
    // already opened would launch a fresh `pi --session` process and overwrite
    // the pool entry, orphaning the previously running process (it could never
    // be terminated, killed on quit, or switched back to). The process must
    // keep running while another session is active, and reopening just
    // re-attaches the same terminal buffer — the "switch, don't kill" contract
    // (design §4, e2e "continuity across switch").
    const existing = this.entries.get(sessionFile);
    if (existing && existing.info.status === 'running') return existing.info;
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
    pty.on('data', (d: string) => this.opts.onData(infoKey, d));
    pty.on('exit', () => { this.opts.onStatus(infoKey, 'dead'); this.opts.onExit(infoKey); });
    this.entries.set(mapKey, { pty, info });
    this.opts.onStatus(infoKey, 'running');
    return info;
  }
  write(key: string, data: string) { this.entries.get(key)?.pty.write(data); }
  resize(key: string, cols: number, rows: number) { this.entries.get(key)?.pty.resize(cols, rows); }
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
  s = s.replace(/--/g, '\\').replace(/^([A-Za-z])-/, '$1:');
  return s;
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
