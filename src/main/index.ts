import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionPool } from './sessionPool';
import type { IPtyLike } from './sessionPool';
import nodePty from 'node-pty';

const SESSIONS_DIR =
  process.env.PI_DESKTOP_SESSIONS_DIR ?? path.join(app.getPath('home'), '.pi', 'agent', 'sessions');

// Resolve the `pi` executable to an absolute path. The electron child process does
// NOT always inherit the user's shell PATH (e.g. when the app is launched by
// double-clicking the .exe), so a bare `pi` fails with ENOENT. We search PATH plus
// the well-known pnpm global bin location, preferring Windows script extensions.
function resolvePi(): string {
  const explicit = process.env.PI_BIN;
  if (explicit) return explicit;
  const exts = ['.cmd', '.exe', '.ps1', '.bat', ''];
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    path.join(os.homedir(), 'AppData', 'Local', 'pnpm', 'bin'),
  ];
  for (const dir of dirs) {
    for (const ext of exts) {
      const cand = path.join(dir, 'pi' + ext);
      if (fs.existsSync(cand)) return cand;
    }
  }
  return 'pi';
}

// `pi.cmd` ultimately runs `node cli.js`, so `node` must also be resolvable in the
// child's PATH. When the app is launched without the user's shell PATH (e.g. by
// double-clicking the .exe), `node` may be missing — so resolve it and prepend it.
function resolveNodeDir(): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    if (fs.existsSync(path.join(dir, 'node.exe')) || fs.existsSync(path.join(dir, 'node'))) return dir;
  }
  const miseNode = path.join(os.homedir(), 'AppData', 'Local', 'mise', 'installs', 'node');
  if (fs.existsSync(miseNode)) {
    for (const ver of fs.readdirSync(miseNode)) {
      const d = path.join(miseNode, ver);
      if (fs.existsSync(path.join(d, 'node.exe'))) return d;
    }
  }
  return undefined;
}

function createPool(win: BrowserWindow) {
  const useFake = process.env.PI_DESKTOP_FAKE === '1';
  const fakeScript = path.join(__dirname, 'fake-pi.mjs');
  const piBin = resolvePi();
  const nodeDir = resolveNodeDir();
  // Ensure `node` (used by the pi.cmd shim) is on the child PATH even when the app
  // was launched without the user's shell PATH.
  const childEnv = nodeDir
    ? { ...process.env, PATH: [nodeDir, process.env.PATH].filter(Boolean).join(path.delimiter) }
    : process.env;
  const ptyFactory = (file: string, args: string[], opts: any): IPtyLike => {
    if (useFake) return nodePty.spawn('node', [fakeScript], { ...opts, shell: true, env: childEnv }) as unknown as IPtyLike;
    // `file` is always 'pi' from the pool; use the resolved absolute path so the
    // real `pi` is found even when PATH doesn't contain the pnpm bin.
    return nodePty.spawn(piBin, args, { ...opts, shell: true, env: childEnv }) as unknown as IPtyLike;
  };
  return new SessionPool(ptyFactory, {
    cols: 80, rows: 24, sessionsDir: SESSIONS_DIR,
    // The window may already be destroyed when these fire (e.g. during killAll on
    // 'closed'), so guard every send to avoid "Object has been destroyed" exceptions.
    onData: (key, data) => { if (!win.isDestroyed()) win.webContents.send('session:data', { key, data }); },
    onStatus: (key, status) => { if (!win.isDestroyed()) win.webContents.send('session:status', { key, status }); },
    onExit: (key) => { if (!win.isDestroyed()) win.webContents.send('session:exit', { key }); },
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100, height: 720,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const pool = createPool(win);

  // 弹出系统原生目录选择对话框（需求 1）。用户取消返回 null。
  ipcMain.handle('session:pickDirectory', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // 会话写盘（用户发首条消息后 pi 写出 .jsonl）即视为"晋升"，推送最新索引给渲染进程。
  // 300ms debounce 合并突发写入。recursive watch 在 Windows/macOS 原生支持。
  let indexTimer: ReturnType<typeof setTimeout> | undefined;
  const pushIndex = () => {
    if (indexTimer) clearTimeout(indexTimer);
    indexTimer = setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.send('session:index', pool.listFiles());
    }, 300);
  };
  try {
    fs.watch(SESSIONS_DIR, { recursive: true }, pushIndex);
  } catch (err) {
    console.error('[session:index] fs.watch failed:', err);
  }

  ipcMain.handle('session:list', () => pool.listFiles());
  ipcMain.handle('session:open', (_e, req: { key?: string; cwd?: string; name?: string }) => {
    try {
      if (req.key) {
        // Disk-backed session → reopen its file. Live session (key already in the
        // pool, e.g. `live-<uuid>`) → return the existing entry so the UI can
        // SWITCH to it instead of spawning a duplicate process.
        if (req.key.endsWith('.jsonl')) return pool.openExisting(req.key);
        const existing = pool.get(req.key);
        if (existing) return existing;
        // Unknown key → open a new session carrying that key.
        return pool.openNew(req.cwd && fs.existsSync(req.cwd) ? req.cwd : process.cwd(), req.name, req.key);
      }
      // The renderer is sandboxed and has no `process`, so default the cwd here
      // in the main process, and fall back to an existing directory to avoid
      // node-pty's ERROR_DIRECTORY (267) on Windows.
      const cwd = req.cwd && fs.existsSync(req.cwd) ? req.cwd : process.cwd();
      return pool.openNew(cwd, req.name);
    } catch (err) {
      console.error('[session:open] failed:', err);
      throw new Error('无法启动 pi 会话，请确认 pi 已在 PATH 中且目录可访问');
    }
  });
  ipcMain.handle('session:terminate', (_e, key: string) => pool.terminate(key));
  ipcMain.handle('session:debug', () => pool.debugInfo());
  ipcMain.on('session:input', (_e, m: { key: string; data: string }) => pool.write(m.key, m.data));
  ipcMain.on('session:resize', (_e, m: { key: string; cols: number; rows: number }) => pool.resize(m.key, m.cols, m.rows));

  win.on('closed', () => pool.killAll());
  app.on('before-quit', () => { /* pool is per-window; killAll already on window 'closed' */ });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
