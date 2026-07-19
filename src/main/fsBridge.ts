import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

// ============================================================================
// Note: path-safety / allowed-roots enforcement was intentionally removed.
// File operations now resolve `root + relPath` directly and trust the caller.
// ============================================================================

// ============================================================================
// Directory listing
// ============================================================================

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export async function listDir(root: string, dir: string): Promise<DirEntry[]> {
  const abs = path.resolve(root, dir);
  const names = await fsp.readdir(abs);
  const entries = await Promise.all(
    names.map(async (name): Promise<DirEntry> => {
      const childRel = path.posix.join(dir, name);
      let stat: fs.Stats;
      try {
        const full = path.resolve(root, childRel);
        stat = await fsp.stat(full);
      } catch {
        // Unreadable entry: surface as a zeroed file rather than throw.
        return { name, isDir: false, size: 0, mtime: 0 };
      }
      return {
        name,
        isDir: stat.isDirectory(),
        size: stat.size,
        mtime: stat.mtimeMs,
      };
    }),
  );
  // Dirs first, then alphabetical — stable and matches typical explorer UX.
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

// ============================================================================
// Read / write / stat
// ============================================================================

const TEXT_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonl', 'md', 'mdx',
  'yaml', 'yml', 'toml', 'py', 'sh', 'bash', 'zsh', 'fish', 'rs', 'go', 'sql',
  'graphql', 'gql', 'html', 'htm', 'css', 'less', 'scss', 'txt', 'log',
  'env', 'gitignore', 'gitattributes', 'gitmodules', 'lock', 'tf', 'hcl',
  'xml', 'csv', 'ini', 'cfg', 'conf', 'dockerfile', 'lock',
]);

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg']);
const PDF_EXTS = new Set(['pdf']);

/** Max size we will load into memory as text (1 MB). */
const MAX_TEXT_BYTES = 1024 * 1024;

export interface ReadResult {
  content: string;
  language: string;
  size: number;
  isBinary: boolean;
  isImage: boolean;
  isPdf: boolean;
  /** base64 data URI for images, when the file is an image and within size cap. */
  dataUrl?: string;
}

function extOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower.startsWith('.') && !lower.includes('.')) return lower.slice(1); // e.g. .env
  const idx = lower.lastIndexOf('.');
  return idx >= 0 ? lower.slice(idx + 1) : '';
}

function languageOf(name: string): string {
  const ext = extOf(name);
  switch (ext) {
    case 'ts': case 'tsx': return 'typescript';
    case 'js': case 'mjs': case 'cjs': case 'jsx': return 'javascript';
    case 'json': case 'jsonl': return 'json';
    case 'py': return 'python';
    case 'md': case 'mdx': return 'markdown';
    case 'yaml': case 'yml': return 'yaml';
    case 'toml': return 'toml';
    case 'rs': return 'rust';
    case 'go': return 'go';
    case 'sql': return 'sql';
    case 'graphql': case 'gql': return 'graphql';
    case 'html': case 'htm': return 'html';
    case 'css': case 'less': case 'scss': return 'css';
    case 'sh': case 'bash': case 'zsh': case 'fish': return 'shell';
    case 'tf': case 'hcl': return 'hcl';
    default: return '';
  }
}

function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export async function readFile(
  root: string,
  relPath: string,
  maxBytes = MAX_TEXT_BYTES,
): Promise<ReadResult> {
  const abs = path.resolve(root, relPath);
  const stat = await fsp.stat(abs);
  const name = path.basename(abs);
  const ext = extOf(name);

  if (IMAGE_EXTS.has(ext)) {
    // Images: return as base64 data URL if within a generous cap (8 MB).
    const cap = 8 * 1024 * 1024;
    if (stat.size > cap) {
      return { content: '', language: 'image', size: stat.size, isBinary: false, isImage: true, isPdf: false };
    }
    const buf = await fsp.readFile(abs);
    const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
    return {
      content: '', language: 'image', size: stat.size, isBinary: false, isImage: true, isPdf: false,
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
    };
  }

  if (PDF_EXTS.has(ext)) {
    return { content: '', language: 'pdf', size: stat.size, isBinary: false, isImage: false, isPdf: true };
  }

  // 已知文本扩展名：直接读。未知扩展名（含无后缀文件）先读内容，再用 NUL 字节
  // 检测是否真二进制——避免把无后缀的纯文本文件误判为二进制无法预览。
  if (stat.size > maxBytes) {
    // 文件过大 → 不读取内容，直接按二进制处理（预览会提示无法预览）。
    return { content: '', language: languageOf(name) || 'text', size: stat.size, isBinary: true, isImage: false, isPdf: false };
  }

  const buf = await fsp.readFile(abs);
  if (TEXT_EXTS.has(ext)) {
    const isBinary = looksBinary(buf);
    if (isBinary) {
      return { content: '', language: 'text', size: stat.size, isBinary: true, isImage: false, isPdf: false };
    }
    return {
      content: buf.toString('utf-8'),
      language: languageOf(name),
      size: stat.size,
      isBinary: false,
      isImage: false,
      isPdf: false,
    };
  }

  // 未知扩展名 / 无后缀：用内容探测是否为二进制；纯文本则可正常预览。
  const isBinary = looksBinary(buf);
  if (isBinary) {
    return { content: '', language: 'text', size: stat.size, isBinary: true, isImage: false, isPdf: false };
  }
  return {
    content: buf.toString('utf-8'),
    language: languageOf(name),
    size: stat.size,
    isBinary: false,
    isImage: false,
    isPdf: false,
  };
}

export async function writeFile(root: string, relPath: string, content: string): Promise<void> {
  const abs = path.resolve(root, relPath);
  await fsp.writeFile(abs, content, 'utf-8');
}

export async function statFile(root: string, relPath: string): Promise<{ size: number; mtime: number; isDir: boolean }> {
  const abs = path.resolve(root, relPath);
  const s = await fsp.stat(abs);
  return { size: s.size, mtime: s.mtimeMs, isDir: s.isDirectory() };
}

// ============================================================================
// File management operations (create / rename / remove / copy / mkdir)
// ============================================================================

/** Create a directory (recursive, like `mkdir -p`). */
export async function mkdir(root: string, relDir: string): Promise<void> {
  const abs = path.resolve(root, relDir);
  await fsp.mkdir(abs, { recursive: true });
}

/** Create a (possibly empty) file at relPath. */
export async function createFile(root: string, relPath: string, content = ''): Promise<void> {
  const abs = path.resolve(root, relPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf-8');
}

/** Rename / move a node (file or directory). `fs.rename` natively supports cross-directory moves. */
export async function rename(root: string, fromRel: string, toRel: string): Promise<void> {
  const from = path.resolve(root, fromRel);
  const to = path.resolve(root, toRel);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
}

/** Remove a file (rm) or directory tree (rm -rf). */
export async function remove(root: string, relPath: string): Promise<void> {
  const abs = path.resolve(root, relPath);
  await fsp.rm(abs, { recursive: true, force: true });
}

/** Copy a file (copyFile) or directory tree (recursive copy). */
export async function copy(root: string, fromRel: string, toRel: string): Promise<void> {
  const from = path.resolve(root, fromRel);
  const to = path.resolve(root, toRel);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await copyRecursive(from, to);
}

async function copyRecursive(from: string, to: string): Promise<void> {
  const stat = await fsp.stat(from);
  if (stat.isDirectory()) {
    await fsp.mkdir(to, { recursive: true });
    const children = await fsp.readdir(from);
    for (const child of children) {
      await copyRecursive(path.join(from, child), path.join(to, child));
    }
  } else {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
  }
}

/** Return the names of direct children in a directory (used for de-dup / suffixing). */
export async function listNames(root: string, dir: string): Promise<string[]> {
  const abs = path.resolve(root, dir);
  return fsp.readdir(abs);
}

/**
 * Given a desired base name and the set of existing sibling names, return a
 * collision-free name by appending ` (1)`, ` (2)`, … before the extension
 * (VS Code style). Returns `base` unchanged if there is no collision.
 */
export function uniqueName(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  const dot = base.lastIndexOf('.');
  const hasExt = dot > 0 && dot < base.length - 1;
  const stem = hasExt ? base.slice(0, dot) : base;
  const ext = hasExt ? base.slice(dot) : '';
  let n = 1;
  let candidate = `${stem} (${n})${ext}`;
  while (existing.has(candidate)) {
    n += 1;
    candidate = `${stem} (${n})${ext}`;
  }
  return candidate;
}
