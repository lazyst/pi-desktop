import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 解码 pi 编码的目录名。
 * pi 的目录名编码：反斜杠 → "--"，盘符冒号被直接丢弃（D: → D）。
 * 还原 Windows 盘符的绝对路径："X\\" → "X:\\"。
 */
export function decodeCwd(enc: string): string {
  let s = enc;
  if (s.startsWith('--')) s = s.slice(2);
  if (s.endsWith('--')) s = s.slice(0, -2);
  s = s.replace(/--/g, '\\');
  return s.replace(/^([A-Za-z])\\/, '$1:\\');
}

/**
 * 从文件名中提取可读时间戳。
 * 文件名格式如 "2026-07-03T19-07-11-857Z_abc.jsonl" → "2026-07-03 19:07"。
 * 不匹配时原样返回。
 */
export function formatTimestamp(filename: string): string {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return filename;
  return `${m[1]} ${m[2]}:${m[3]}`;
}

/**
 * 读取 session 文件的第一行 JSON，提取 cwd 字段。
 */
export function readSessionCwd(file: string): string | undefined {
  try {
    const line = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
    const obj = JSON.parse(line);
    return typeof obj?.cwd === 'string' ? obj.cwd : undefined;
  } catch { return undefined; }
}

/**
 * 读取 session 文件中可读名称，优先级：
 * 1. 最新的 session_info 条目的 name 字段（由 /name 命令设置）
 * 2. 第一条 user 消息（截断到 80 字符）
 * 3. undefined（无匹配时）
 */
export function readSessionName(file: string): string | undefined {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return undefined; }
  try {
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('utf8', 0, n);

    let sessionInfoName: string | undefined;
    let firstUserMessage: string | undefined;

    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (obj?.type === 'session_info' && typeof obj.name === 'string' && obj.name.trim()) {
          // 记录最新的 session_info name（行顺序即时间顺序，后来的覆盖前面的）
          sessionInfoName = obj.name.trim();
        } else if (obj?.type === 'message' && obj?.message?.role === 'user' && !firstUserMessage) {
          const c = obj.message.content;
          const str = Array.isArray(c)
            ? c.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join(' ')
            : String(c ?? '');
          const clean = str.replace(/\s+/g, ' ').trim();
          if (clean) firstUserMessage = clean.length > 80 ? clean.slice(0, 80) : clean;
        }
      } catch { /* skip non-JSON / malformed lines */ }
    }

    // 优先返回 session_info 中的 name
    if (sessionInfoName) return sessionInfoName;
    if (firstUserMessage) return firstUserMessage;
  } catch { /* ignore read errors (e.g. file being written) */
  } finally {
    try { fs.closeSync(fd); } catch { /* noop */ }
  }
  return undefined;
}

/**
 * 读取目录下第一个 .jsonl 文件的 cwd 作为该目录的 cwd。
 */
export function readGroupCwd(dir: string): string | undefined {
  const first = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
  return first ? readSessionCwd(path.join(dir, first)) : undefined;
}