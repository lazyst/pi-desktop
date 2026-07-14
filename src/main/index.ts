import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import { SessionPool } from './sessionPool';
import type { IPtyLike } from './sessionPool';
import nodePty from 'node-pty';

const SESSIONS_DIR = path.join(app.getPath('home'), '.pi', 'agent', 'sessions');

function createPool(win: BrowserWindow) {
  const useFake = process.env.PI_DESKTOP_FAKE === '1';
  const fakeScript = path.join(__dirname, 'fake-pi.mjs');
  const ptyFactory = (file: string, args: string[], opts: any): IPtyLike => {
    if (useFake) return nodePty.spawn('node', [fakeScript], { ...opts, shell: true }) as unknown as IPtyLike;
    return nodePty.spawn(file, args, { ...opts, shell: true }) as unknown as IPtyLike;
  };
  return new SessionPool(ptyFactory, {
    cols: 80, rows: 24, sessionsDir: SESSIONS_DIR,
    onData: (key, data) => win.webContents.send('session:data', { key, data }),
    onStatus: (key, status) => win.webContents.send('session:status', { key, status }),
    onExit: (key) => win.webContents.send('session:exit', { key }),
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

  ipcMain.handle('session:list', () => pool.listFiles());
  ipcMain.handle('session:open', (_e, req: { key?: string; cwd?: string; name?: string }) => {
    try {
      if (req.key && req.key.endsWith('.jsonl')) return pool.openExisting(req.key);
      if (req.cwd) return pool.openNew(req.cwd, req.name);
      throw new Error('session:open requires key or cwd');
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
