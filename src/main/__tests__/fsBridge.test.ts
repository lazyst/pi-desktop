import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  listDir,
  readFile,
  writeFile,
  statFile,
  mkdir,
  createFile,
  rename,
  remove,
  copy,
  listNames,
  uniqueName,
  watchDir,
} from '../fsBridge';

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
    const entries = await listDir(dir, '');
    expect(entries.map((e) => e.name)).toEqual(['b', 'a.txt', 'c.txt']);
    expect(entries[0].isDir).toBe(true);
    expect(entries[1].isDir).toBe(false);
    expect(entries[1].size).toBe(5);
  });

  it('reads and writes a text file', async () => {
    await writeFile(dir, 'note.md', '# title');
    const res = await readFile(dir, 'note.md');
    expect(res.content).toBe('# title');
    expect(res.language).toBe('markdown');
    expect(res.isBinary).toBe(false);
  });

  it('stats a file', async () => {
    fs.writeFileSync(path.join(dir, 'f.txt'), 'abc');
    const s = await statFile(dir, 'f.txt');
    expect(s.size).toBe(3);
    expect(s.isDir).toBe(false);
  });

  it('flags binary content as isBinary', async () => {
    const buf = Buffer.from([0, 1, 2, 0, 3, 4]);
    fs.writeFileSync(path.join(dir, 'blob.bin'), buf);
    const res = await readFile(dir, 'blob.bin');
    expect(res.isBinary).toBe(true);
  });

  it('mkdir creates nested directories (mkdir -p)', async () => {
    await mkdir(dir, 'a/b/c');
    expect(fs.existsSync(path.join(dir, 'a/b/c'))).toBe(true);
  });

  it('createFile creates an empty file by default', async () => {
    await createFile(dir, 'new.txt');
    const s = await statFile(dir, 'new.txt');
    expect(s.size).toBe(0);
    expect(s.isDir).toBe(false);
  });

  it('createFile creates parent directories', async () => {
    await createFile(dir, 'x/y/z.txt', 'hi');
    expect(fs.readFileSync(path.join(dir, 'x/y/z.txt'), 'utf-8')).toBe('hi');
  });

  it('rename moves a file', async () => {
    await writeFile(dir, 'old.txt', 'data');
    await rename(dir, 'old.txt', 'renamed.txt');
    expect(fs.existsSync(path.join(dir, 'renamed.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'old.txt'))).toBe(false);
  });

  it('rename moves a directory tree', async () => {
    await mkdir(dir, 'src/sub');
    await writeFile(dir, 'src/a.txt', '1');
    await writeFile(dir, 'src/sub/b.txt', '2');
    await rename(dir, 'src', 'dest');
    expect(fs.existsSync(path.join(dir, 'dest/a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'dest/sub/b.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'src'))).toBe(false);
  });

  it('remove deletes a file', async () => {
    await writeFile(dir, 'gone.txt', 'x');
    await remove(dir, 'gone.txt');
    expect(fs.existsSync(path.join(dir, 'gone.txt'))).toBe(false);
  });

  it('remove deletes a directory tree', async () => {
    await mkdir(dir, 'tree/sub');
    await writeFile(dir, 'tree/a.txt', 'x');
    await remove(dir, 'tree');
    expect(fs.existsSync(path.join(dir, 'tree'))).toBe(false);
  });

  it('copy copies a file', async () => {
    await writeFile(dir, 'a.txt', 'copy-me');
    await copy(dir, 'a.txt', 'b.txt');
    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf-8')).toBe('copy-me');
  });

  it('copy copies a directory tree', async () => {
    await mkdir(dir, 'src/sub');
    await writeFile(dir, 'src/a.txt', '1');
    await writeFile(dir, 'src/sub/b.txt', '2');
    await copy(dir, 'src', 'dup');
    expect(fs.readFileSync(path.join(dir, 'dup/a.txt'), 'utf-8')).toBe('1');
    expect(fs.readFileSync(path.join(dir, 'dup/sub/b.txt'), 'utf-8')).toBe('2');
  });

  it('listNames returns direct child names', async () => {
    await mkdir(dir, 'd');
    await writeFile(dir, 'f.txt', 'x');
    const names = await listNames(dir, '');
    expect(names.sort()).toEqual(['d', 'f.txt']);
  });
});

describe('watchDir (external change detection)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fswatch-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fires onChange when a file is created externally', async () => {
    let fired = 0;
    const stop = watchDir(dir, '', () => { fired++; });
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(path.join(dir, 'created.txt'), 'x');
    await new Promise((r) => setTimeout(r, 200));
    expect(fired).toBeGreaterThan(0);
    stop();
  });

  it('stops firing after unsubscribe', async () => {
    let fired = 0;
    const stop = watchDir(dir, '', () => { fired++; });
    await new Promise((r) => setTimeout(r, 50));
    stop();
    fs.writeFileSync(path.join(dir, 'after-stop.txt'), 'x');
    await new Promise((r) => setTimeout(r, 200));
    expect(fired).toBe(0);
  });
});

describe('uniqueName', () => {
  it('returns base unchanged when no collision', () => {
    expect(uniqueName('a.txt', new Set(['b.txt']))).toBe('a.txt');
  });

  it('appends (1) on collision', () => {
    expect(uniqueName('a.txt', new Set(['a.txt']))).toBe('a (1).txt');
  });

  it('finds the next free index', () => {
    const existing = new Set(['a.txt', 'a (1).txt', 'a (2).txt']);
    expect(uniqueName('a.txt', existing)).toBe('a (3).txt');
  });

  it('handles names without extension', () => {
    expect(uniqueName('notes', new Set(['notes']))).toBe('notes (1)');
  });
});
