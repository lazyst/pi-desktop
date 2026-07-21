import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SessionGroup {
  cwd: string;
  sessions: Array<{ key: string; name: string; time: string }>;
}

export class SessionFileManager {
  constructor(private sessionsDir: string) {}

  listFiles(): SessionGroup[] {
    const root = this.sessionsDir;
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

  dirForCwd(cwd: string): string | undefined {
    const root = this.sessionsDir;
    if (!fs.existsSync(root)) return undefined;
    for (const enc of fs.readdirSync(root)) {
      const dir = path.join(root, enc);
      if (!fs.statSync(dir).isDirectory()) continue;
      const groupCwd = readGroupCwd(dir) ?? decodeCwd(enc);
      if (groupCwd === cwd) return dir;
    }
    return undefined;
  }

  deleteSession(key: string): void {
    if (!key.endsWith('.jsonl')) return;
    const dir = path.resolve(this.sessionsDir);
    const target = path.resolve(key);
    const inside = target === dir || target.startsWith(dir + path.sep);
    if (!inside) return;
    try { fs.rmSync(target, { force: true }); } catch { /* 忽略占用 / 竞态 */ }
  }

  deleteMany(keys: string[]): void {
    for (const k of keys) this.deleteSession(k);
  }

  clearDirectory(cwd: string): void {
    const dir = this.dirForCwd(cwd);
    if (!dir) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* 忽略占用 / 竞态 */ }
    }
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* 非空或被占用 */ }
  }

  debugInfo(liveEntries: Map<string, any>): { count: number; pids: number[] } {
    const running = [...liveEntries.values()].filter((e: any) => e.info?.status === 'running');
    return { count: running.length, pids: running.map((e: any) => e.pty?.pid ?? -1).filter((p: number) => p > 0) };
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

export function readSessionCwd(file: string): string | undefined {
  try {
    const line = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
    const obj = JSON.parse(line);
    return typeof obj?.cwd === 'string' ? obj.cwd : undefined;
  } catch { return undefined; }
}

// A session's human-friendly name is the text of its first user message.
// The .jsonl stores no explicit title, so derive it from the first user turn.
export function readSessionName(file: string): string | undefined {
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

export function readGroupCwd(dir: string): string | undefined {
  const first = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
  return first ? readSessionCwd(path.join(dir, first)) : undefined;
}
