import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveSafe,
  listDir,
  readFile,
  writeFile,
  statFile,
  FsSecurityError,
} from '../fsBridge';

describe('fsBridge path safety', () => {
  const root = '/allowed/dir';
  const roots = [root];

  it('accepts a path inside an allowed root', () => {
    const r = resolveSafe(root, 'sub/file.txt', roots);
    expect(r).toBe(path.resolve(root, 'sub/file.txt'));
  });

  it('accepts the root itself', () => {
    const r = resolveSafe(root, '.', roots);
    expect(r).toBe(path.resolve(root));
  });

  it('rejects a traversal escaping the root', () => {
    expect(() => resolveSafe(root, '../../etc/passwd', roots)).toThrow(FsSecurityError);
  });

  it('rejects an absolute path outside the roots', () => {
    expect(() => resolveSafe(root, '/etc/passwd', roots)).toThrow(FsSecurityError);
  });

  it('rejects when no allowed roots configured', () => {
    expect(() => resolveSafe(root, 'x', [])).toThrow(FsSecurityError);
  });

  it('rejects prefix false-positives (foo-bar ∌ foo)', () => {
    // "/allowed/dirbar" must NOT satisfy "/allowed/dir"
    expect(() => resolveSafe('/allowed/dir', '../dirbar/evil', ['/allowed/dir'])).toThrow(FsSecurityError);
  });

  it('resolves ".." upward but still inside root', () => {
    const r = resolveSafe('/allowed/dir', 'sub/../other.txt', ['/allowed/dir']);
    expect(r).toBe(path.resolve('/allowed/dir/other.txt'));
  });
});

describe('fsBridge io (real tmp dir)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsbridge-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists a directory with dirs before files, alphabetical', async () => {
    fs.mkdirSync(path.join(dir, 'b'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'world');
    const entries = await listDir(dir, '', [dir]);
    expect(entries.map((e) => e.name)).toEqual(['b', 'a.txt', 'c.txt']);
    expect(entries[0].isDir).toBe(true);
    expect(entries[1].isDir).toBe(false);
    expect(entries[1].size).toBe(5);
  });

  it('reads and writes a text file', async () => {
    await writeFile(dir, 'note.md', '# title', [dir]);
    const res = await readFile(dir, 'note.md', [dir]);
    expect(res.content).toBe('# title');
    expect(res.language).toBe('markdown');
    expect(res.isBinary).toBe(false);
  });

  it('refuses to write outside allowed roots', async () => {
    await expect(writeFile(dir, '../../escape.txt', 'x', [dir])).rejects.toThrow(FsSecurityError);
  });

  it('stats a file', async () => {
    fs.writeFileSync(path.join(dir, 'f.txt'), 'abc');
    const s = await statFile(dir, 'f.txt', [dir]);
    expect(s.size).toBe(3);
    expect(s.isDir).toBe(false);
  });

  it('flags binary content as isBinary', async () => {
    const buf = Buffer.from([0, 1, 2, 0, 3, 4]);
    fs.writeFileSync(path.join(dir, 'blob.bin'), buf);
    const res = await readFile(dir, 'blob.bin', [dir]);
    expect(res.isBinary).toBe(true);
  });
});
