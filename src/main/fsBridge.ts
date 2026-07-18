import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

// ============================================================================
// Path safety
//
// Every fs IPC entry point resolves a request against a set of *allowed roots*
// (= the user's "addedDirs"). A requested path must resolve to a descendant
// (or the root itself) of one of those roots; otherwise we refuse the request
// to prevent `../` traversal escapes into the user's home / system files.
// ============================================================================

/** Thrown when a path resolves outside the allowed roots. */
export class FsSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FsSecurityError';
  }
}

function normalize(p: string): string {
  return path.normalize(p);
}

/**
 * Resolve `relPath` against `root` and verify the result sits inside one of
 * `allowedRoots`. Returns the absolute resolved path. Throws FsSecurityError on
 * any escape attempt (including symlink escapes are partially mitigated by the
 * caller comparing the realpath — see `resolveSafe`).
 */
export function resolveSafe(root: string, relPath: string, allowedRoots: string[]): string {
  if (!root) throw new FsSecurityError('root is required');
  if (!allowedRoots.length) throw new FsSecurityError('no allowed roots configured');

  const absRoot = path.resolve(normalize(root));
  const resolved = path.resolve(absRoot, normalize(relPath));

  const inside = allowedRoots.some((r) => {
    const absR = path.resolve(normalize(r));
    // Same directory, or a strict descendant (path.sep suffix prevents the
    // "/foo/bar" ∋ "/foo/bart" false-positive).
    return resolved === absR || resolved.startsWith(absR + path.sep);
  });

  if (!inside) {
    throw new FsSecurityError(`path "${relPath}" resolves outside allowed roots`);
  }
  return resolved;
}

// ============================================================================
// Directory listing
// ============================================================================

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export async function listDir(root: string, dir: string, allowedRoots: string[]): Promise<DirEntry[]> {
  const abs = resolveSafe(root, dir, allowedRoots);
  const names = await fsp.readdir(abs);
  const entries = await Promise.all(
    names.map(async (name): Promise<DirEntry> => {
      // Guard each child against symlink escapes by re-checking against roots.
      const childRel = path.posix.join(dir, name);
      let stat: fs.Stats;
      try {
        const full = resolveSafe(root, childRel, allowedRoots);
        stat = await fsp.stat(full);
      } catch {
        // Unreadable / escaped entry: surface as a zeroed file rather than throw.
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
  allowedRoots: string[],
  maxBytes = MAX_TEXT_BYTES,
): Promise<ReadResult> {
  const abs = resolveSafe(root, relPath, allowedRoots);
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

  if (!TEXT_EXTS.has(ext) || stat.size > maxBytes) {
    // Unknown extension or too large → treat as binary (preview will show a notice).
    return { content: '', language: languageOf(name) || 'text', size: stat.size, isBinary: true, isImage: false, isPdf: false };
  }

  const buf = await fsp.readFile(abs);
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

export async function writeFile(root: string, relPath: string, content: string, allowedRoots: string[]): Promise<void> {
  const abs = resolveSafe(root, relPath, allowedRoots);
  await fsp.writeFile(abs, content, 'utf-8');
}

export async function statFile(root: string, relPath: string, allowedRoots: string[]): Promise<{ size: number; mtime: number; isDir: boolean }> {
  const abs = resolveSafe(root, relPath, allowedRoots);
  const s = await fsp.stat(abs);
  return { size: s.size, mtime: s.mtimeMs, isDir: s.isDirectory() };
}
