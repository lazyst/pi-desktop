import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionPool } from './sessionPool';
import type { IPtyLike } from './sessionPool';
import nodePty from 'node-pty';

// 配置存储（主进程唯一真源，见 docs/adr/0001）。纯函数（默认 / 解析 / 合并）在 ./config，
// 便于在无 Electron 环境下单测；此处负责带防抖写盘的实例化与 IPC 暴露。
import { defaultConfig, parseConfig, mergeConfig } from './config';
import type { AppConfig } from '../renderer/src/types';

const configPath = () => path.join(app.getPath('userData'), 'config.json');
let configState: AppConfig | undefined;
let configTimer: ReturnType<typeof setTimeout> | undefined;
let configDirty = false;
// 真正退出标志：关闭按钮默认只隐藏窗口（不杀进程），仅「退出」/系统 quit 置位。
let quitting = false;
// 托盘常驻：生命周期与应用一致，不随窗口显隐销毁（见 issue 01 / 04）。
let tray: Tray | undefined;

function loadConfig(): AppConfig {
  try {
    return parseConfig(fs.readFileSync(configPath(), 'utf-8'));
  } catch {
    return defaultConfig();
  }
}

function ensureLoaded(): void {
  if (configState === undefined) configState = loadConfig();
}

function writeConfigNow(): void {
  if (!configState) return;
  try {
    fs.writeFileSync(configPath(), JSON.stringify(configState, null, 2));
  } catch (err) {
    console.error('[config] failed to write config.json:', err);
  }
}

function getConfig(): AppConfig {
  ensureLoaded();
  return configState!;
}

function setConfig(partial: Partial<AppConfig>): void {
  ensureLoaded();
  configState = mergeConfig(configState!, partial);
  configDirty = true;
  if (configTimer) clearTimeout(configTimer);
  // 防抖写盘：拖拽 / 缩放等高频变更下避免频繁 IO。
  configTimer = setTimeout(() => {
    configTimer = undefined;
    configDirty = false;
    writeConfigNow();
  }, 100);
}

// 退出前强制落盘，避免 100ms 防抖窗口内的最近一次写入丢失。
app.on('before-quit', () => {
  if (configTimer) {
    clearTimeout(configTimer);
    configTimer = undefined;
  }
  if (configDirty) {
    configDirty = false;
    writeConfigNow();
  }
});

// 解析托盘图标路径：dev 用源码、build 用 copy-assets 拷贝出的 out/main/assets，
// 打包（asar）回退到 resources/assets（见 issue 01）。
function resolveTrayIcon(): string {
  const candidates = [
    path.join(__dirname, 'assets', 'tray-icon.png'),
    path.join(__dirname, '..', '..', 'src', 'main', 'assets', 'tray-icon.png'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const packed = path.join(process.resourcesPath, 'assets', 'tray-icon.png');
  if (fs.existsSync(packed)) return packed;
  return candidates[0];
}

// 显示并聚焦窗口（托盘「显示」/双击触发）。
function showWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (win.isVisible()) win.focus();
  else { win.show(); win.focus(); }
}

// 创建常驻系统托盘：右键「显示 / 退出」，双击显示并聚焦（见 issue 01）。
function createTray(win: BrowserWindow): void {
  try {
    const iconPath = resolveTrayIcon();
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) console.warn('[tray] icon missing at', iconPath);
    tray = new Tray(icon);
    tray.setToolTip('pi-desktop');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示', click: () => showWindow(win) },
        { label: '退出', click: () => app.quit() },
      ]),
    );
    tray.on('double-click', () => showWindow(win));
  } catch (err) {
    console.error('[tray] failed to create system tray:', err);
  }
}

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
    onRelink: (from, to) => { if (!win.isDestroyed()) win.webContents.send('session:relink', { from, to }); },
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100, height: 720,
    frame: false, // 无边框：原生菜单与标题条随之消失（任务 2），标题条改由渲染进程自建（任务 3）
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const pool = createPool(win);

  // 配置存储：渲染进程经 IPC 读写主进程 config.json（唯一真源，见 docs/adr/0001）。
  ipcMain.handle('config:get', () => getConfig());
  ipcMain.handle('config:set', (_e, partial: Partial<AppConfig>) => {
    setConfig(partial);
    if (!win.isDestroyed()) win.webContents.send('config:change', getConfig());
  });

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
      if (win.isDestroyed()) return;
      const groups = pool.listFiles();
      // Link freshly-written disk sessions to the live processes that created them
      // so clicking a promoted sidebar entry reuses the same process.
      pool.reconcile(groups);
      win.webContents.send('session:index', groups);
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
  ipcMain.handle('session:delete', (_e, key: string) => {
    pool.deleteSession(key);
    pushIndex(); // 与 fs.watch debounce 互补，保证侧边栏即时更新
  });
  ipcMain.handle('session:deleteMany', (_e, keys: string[]) => {
    pool.deleteMany(keys);
    pushIndex(); // 与 fs.watch debounce 互补，保证侧边栏即时更新
  });
  ipcMain.handle('session:clearDirectory', (_e, cwd: string) => {
    pool.clearDirectory(cwd);
    pushIndex(); // 与 fs.watch debounce 互补，保证侧边栏即时更新
  });
  ipcMain.handle('session:debug', () => pool.debugInfo());
  ipcMain.on('session:input', (_e, m: { key: string; data: string }) => pool.write(m.key, m.data));
  ipcMain.on('session:resize', (_e, m: { key: string; cols: number; rows: number }) => pool.resize(m.key, m.cols, m.rows));

  // 无边框窗口的窗口控制（自建标题条调用）
  ipcMain.on('window:minimize', () => { if (!win.isDestroyed()) win.minimize(); });
  ipcMain.on('window:toggle-maximize', () => {
    if (win.isDestroyed()) return;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  });
  ipcMain.on('window:close', () => { if (!win.isDestroyed()) win.close(); });
  ipcMain.handle('window:get-bounds', () => win.getBounds());
  ipcMain.on('window:set-bounds', (_e, b: { x: number; y: number; width: number; height: number }) => {
    if (!win.isDestroyed()) win.setBounds(b);
  });
  win.on('maximize', () => { if (!win.isDestroyed()) win.webContents.send('window:maximize-change', true); });
  win.on('unmaximize', () => { if (!win.isDestroyed()) win.webContents.send('window:maximize-change', false); });

  // 关闭语义（见 issue 03 / docs/adr/0001 决策③）：
  //  - minimize-to-tray（默认）：拦截关闭、隐藏窗口、进程继续跑（托盘可恢复）。
  //  - close：真正退出应用；app.quit() 经 before-quit 置 quitting 并杀掉全部 pi 进程。
  win.on('close', (e) => {
    if (quitting) return; // 真正退出路径：放行 window 关闭
    if (getConfig().closeBehavior === 'minimize-to-tray') {
      e.preventDefault();
      win.hide();
    } else {
      // 「直接关闭」：拦截本次关闭，改走统一退出流程（before-quit → killAll → 退出）。
      e.preventDefault();
      app.quit();
    }
  });

  // 真正退出统一走 before-quit：置 quitting、杀掉所有运行中的 pi 进程。
  // 关闭按钮（minimize-to-tray）只隐藏窗口、不会触发 before-quit，故进程保持存活。
  app.on('before-quit', () => {
    quitting = true;
    pool.killAll();
  });

  // 常驻托盘在窗口就绪后创建（见 issue 01）。
  createTray(win);

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(createWindow);
// 窗口隐藏（非关闭）时应用保持存活；托盘常驻即入口，真正退出只经 before-quit
// （见 issue 04）。macOS 本就不退出，其余平台也不再因窗口"关闭"（实为隐藏）而退出。
app.on('window-all-closed', () => { /* 托盘常驻：不自动退出，仅 before-quit 触发真正退出 */ });
