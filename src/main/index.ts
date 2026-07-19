import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain, shell } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { SessionPool } from './sessionPool';
import type { IPtyLike } from './sessionPool';
import nodePty from 'node-pty';
import { listDir, readFile, writeFile, statFile, FsSecurityError } from './fsBridge';
import { gitStatus, gitLog, gitDiff } from './gitBridge';

// 终端渲染：xterm 的 WebGL(GPU) 渲染器能彻底消除流式高频重绘的闪烁（学习 VS Code 的
// terminal.integrated.gpuAcceleration 机制）。现代 Electron/Chromium 在无硬件 GPU 时
// 默认禁用 WebGL 且不再自动软件回退，会导致 xterm 静默回退到 DOM 渲染器而闪烁。
// 显式允许 SwiftShader 软件回退（对应 VS Code 的 gpuAcceleration: 'swiftshader'）：
// 有硬件 GPU 时仍走硬件 WebGL，无硬件时走软件 WebGL，保证 GPU 渲染器始终可用。
// 必须在 app ready / GPU 进程启动前设置。
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

// 配置存储（主进程唯一真源，见 docs/adr/0001）。纯函数（默认 / 解析 / 合并）在 ./config，
// 便于在无 Electron 环境下单测；此处负责带防抖写盘的实例化与 IPC 暴露。
import { defaultConfig, parseConfig, mergeConfig } from './config';
import { snapshotWindowState, initialBoundsOptions } from './windowState';
import { IntegratedTerminalPool } from './integratedTerminalPool';
import { detectTerminalProfiles } from './shellProfiles';
import type { AppConfig, TerminalProfile } from '../renderer/src/types';

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
  // 像 VS Code / 其他终端模拟器一样，向 pty 显式声明终端类型与真彩色支持。
  // 否则从 GUI 启动的 Electron 主进程不携带 TERM，pi-tui 会降级运行：不隐藏硬件光标
  // （光标在 pi-tui 自建光标之上闪烁）→ 残留闪烁；布局模式不同 → 内容遮挡底部编辑器。
  // 关键：TERM_PROGRAM 必须声明为 vscode——pi-tui 依据 TERM_PROGRAM==='vscode'（及
  // VSCODE_* 环境标记）启用稳定的差分渲染模式（打字机式输出、无逐帧闪烁/滚屏跳动）。
  // 声明为 'pi-desktop' 会让 pi-tui 走降级渲染路径，出现最新行闪烁 + 编辑器上下跳。
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'vscode',
    TERM_PROGRAM_VERSION: '1.128.1',
  };
  // Ensure `node` (used by the pi.cmd shim) is on the child PATH even when the app
  // was launched without the user's shell PATH.
  if (nodeDir) childEnv.PATH = [nodeDir, process.env.PATH].filter(Boolean).join(path.delimiter);
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
    // 背压回传（对齐 VS Code acknowledgeDataEvent）：渲染端每消费 N 字节即经 IPC 上报，
    // 由 SessionPool.acknowledgeDataEvent 记账（见下方 ipcMain.on('session:ack')）。
    // 注意：此处**不能**写成 `() => pool.acknowledgeDataEvent(...)` —— 那会自引用无限递归，
    // 且 pool 在本闭包创建时（createPool 同步执行期）还处于 const TDZ，点击会话触发 IPC
    // 时会抛 `ReferenceError: pool is not defined`。SessionPool 内部已自记账，故钩子省略，
    // 回传入口统一走 ipcMain.on('session:ack') → pool.acknowledgeDataEvent。
  });
}

function createWindow() {
  const cfg = getConfig();
  // 还原上次窗口几何（最大化状态单独存标志，bounds 永远是非最大化尺寸）。
  // show:false —— 启动动画（splash）由 renderer 首屏就绪后经 splash:done IPC 触发
  // show()，避免在「无边框窗口 + 内容异步加载」下先闪白框再显示内容（见 docs/adr/0003）。
  const win = new BrowserWindow({
    ...initialBoundsOptions(cfg.window.bounds),
    show: false,
    frame: false, // 无边框：原生菜单与标题条随之消失（任务 2），标题条改由渲染进程自建（任务 3）
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 把初始 config 同步注入渲染进程（见 preload 的 getInitialConfig），
      // 使其首屏即可拿到正确主题，避免异步读取导致的暗→亮闪烁。
      additionalArguments: [`--pi-initial-config=${encodeURIComponent(JSON.stringify(cfg))}`],
    },
  });
  if (cfg.window.maximized) win.maximize();
  // 开发调试：Ctrl+Shift+I / F12 切换 DevTools，便于查看渲染进程 console / 网络。
  // （本应用无内置 DevTools 入口，故在此补一个快捷键。）
  win.webContents.on('before-input-event', (_e, input) => {
    const isDevToolsKey =
      input.key === 'F12' ||
      (input.control && input.shift && (input.key === 'I' || input.key === 'i'));
    if (isDevToolsKey) {
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
      else win.webContents.openDevTools();
    }
  });

  // ── 链接跳转纵深防御（见 grilling 会话结论）──
  // 应用内渲染层未来可能渲染可点击外部链接（文档/设置/预览）。Electron 默认对
  // <a target="_blank"> / window.open 在新版 Chromium 下仅静默 block，且 will-navigate
  // 不拦截时恶意/意外链接可把整个 BrowserWindow 带离本地上下文。故在此做双重锁：
  //  1) setWindowOpenHandler 一律 deny——应用内不需要弹新窗口。
  //  2) will-navigate 只放行应用自身来源（生产 loadFile 的 file://、开发 Vite 的
  //     http://localhost HMR）；其余 URL 一律拦截并甩给系统默认程序（shell.openExternal）。
  // 注意：本项目未注册自定义 app:// 协议，生产以 file:// 加载，故放行集为 file:// + 本地 dev。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    const allowed =
      url.startsWith('file://') || // 生产 loadFile / 本地文件系统
      /^https?:\/\/localhost(:\d+)?\//.test(url); // 开发 Vite dev server（HMR）
    if (!allowed) {
      e.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  const pool = createPool(win);

  // 集成终端池：独立运行的真实用户 shell 进程池，与 SessionPool（跑 pi 会话、写 .jsonl）
  // 完全解耦（不写盘、不进会话索引），用于渲染层内嵌的集成终端抽屉。
  const termPool = new IntegratedTerminalPool({
    cols: 80, rows: 24,
    onData: (id, data) => { if (!win.isDestroyed()) win.webContents.send('term:data', { id, data }); },
    onExit: (id) => { if (!win.isDestroyed()) win.webContents.send('term:exit', { id }); },
  });

  // 列出当前平台可用的终端 profile（供设置面板下拉 + 新建终端默认选择）
  ipcMain.handle('terminal:listProfiles', () => detectTerminalProfiles());
  // 用指定 profile 在 cwd 创建集成终端；profile 由渲染端从 listProfiles 结果传入（只需 id/path/args/platform），
  // 或从 config 读取 defaultTerminalProfile 解析。此处直接接收完整 profile 对象即可。
  ipcMain.handle('terminal:create', (_e, req: { profile: TerminalProfile; cwd: string }) => {
    try {
      return termPool.create(req.profile, req.cwd);
    } catch (err) {
      console.error('[terminal:create] failed:', err);
      throw new Error('无法启动集成终端，请确认所选 shell 可用');
    }
  });
  ipcMain.on('terminal:input', (_e, m: { id: string; data: string }) => termPool.write(m.id, m.data));
  ipcMain.on('terminal:resize', (_e, m: { id: string; cols: number; rows: number }) => termPool.resize(m.id, m.cols, m.rows));
  ipcMain.handle('terminal:destroy', (_e, id: string) => termPool.destroy(id));

  // 受控外部链接通道：渲染层经此桥请求打开外部程序（系统浏览器/mail 客户端）。
  // file:// 不走此通道，永远由 PdfPreview 的隔离 <webview> + fsBridge bounds-check 处理，
  // 以免绕过路径越界保护。自用工具，不打扰确认，直接开。
  ipcMain.handle('app:openExternal', (_e, url: string): boolean => {
    if (typeof url !== 'string' || !url) return false;
    let u: URL;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'mailto:') {
      return false;
    }
    shell.openExternal(url).catch(() => {});
    return true;
  });

  // 记住窗口几何与最大化状态（见 docs/adr/0001 决策②）：maximize / unmaximize /
  // resize / move 实时（防抖 200ms）回写 config.window。用 getNormalBounds() 取非
  // 最大化几何，无论当前是否最大化，存进去的都是「还原后」的尺寸。
  let winStateTimer: ReturnType<typeof setTimeout> | undefined;
  const persistWindowState = () => {
    if (winStateTimer) clearTimeout(winStateTimer);
    winStateTimer = setTimeout(() => {
      winStateTimer = undefined;
      if (win.isDestroyed()) return;
      setConfig({ window: snapshotWindowState(win) });
    }, 200);
  };
  win.on('maximize', persistWindowState);
  win.on('unmaximize', persistWindowState);
  win.on('resize', persistWindowState);
  win.on('move', persistWindowState);

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

  // 图片粘贴落盘：渲染端把系统剪贴板里的图片读成 base64 后传来，主进程写到系统临时目录，
  // 返回绝对路径。前端再把该路径当文本粘贴进终端（模拟 VS Code「拖拽文件到终端」的 sendPath
  // 行为——终端本身不渲染图片数据，只接收文件路径）。文件名带 uuid 防碰撞，扩展名取传入的 ext。
  ipcMain.handle('session:saveImage', (_e, payload: { data: string; ext: string }) => {
    try {
      if (!payload || typeof payload.data !== 'string' || !payload.data) return null;
      const ext = (payload.ext || 'png').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'png';
      const tmpDir = app.getPath('temp');
      const name = `pi-paste-${crypto.randomUUID()}.${ext}`;
      const filePath = path.join(tmpDir, name);
      // payload.data 是 base64（不含 data: 前缀）；用 base64 解码写盘，避免 atob 的 Latin1 陷阱。
      const buf = Buffer.from(payload.data, 'base64');
      fs.writeFileSync(filePath, buf);
      return filePath;
    } catch (err) {
      console.error('[session:saveImage] failed:', err);
      return null;
    }
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
  // 背压回传：渲染端每消费 N 字节即上报，主进程更新该会话的消费进度（对齐 VS Code acknowledgeDataEvent）。
  ipcMain.on('session:ack', (_e, m: { key: string; bytes: number }) => pool.acknowledgeDataEvent(m.key, m.bytes));

  // ── 文件管理器（A + B 预览）只读/写 IPC ──
  // 所有 fs 通道统一在主进程做路径安全校验：请求的 root + relPath 必须落在
  // config.addedDirs（allowedRoots）之内，防止越界读写用户目录（见 docs/plan-file-manager-preview-git.md）。
  const allowedRoots = (): string[] => {
    const dirs = getConfig().addedDirs;
    return Array.isArray(dirs) ? dirs.filter((d) => typeof d === 'string') : [];
  };
  ipcMain.handle('fs:listDir', (_e, req: { root: string; dir: string }) =>
    listDir(req.root, req.dir, allowedRoots()));
  ipcMain.handle('fs:readFile', (_e, req: { root: string; path: string; maxBytes?: number }) =>
    readFile(req.root, req.path, allowedRoots(), req.maxBytes));
  ipcMain.handle('fs:writeFile', (_e, req: { root: string; path: string; content: string }) =>
    writeFile(req.root, req.path, req.content, allowedRoots()));
  ipcMain.handle('fs:stat', (_e, req: { root: string; path: string }) =>
    statFile(req.root, req.path, allowedRoots()));

  // ── Git 只读查看（D）── 非 git 目录优雅降级（见 gitBridge，永不抛错）。
  ipcMain.handle('git:status', (_e, req: { cwd: string }) => gitStatus(req.cwd));
  ipcMain.handle('git:log', (_e, req: { cwd: string; limit?: number }) => gitLog(req.cwd, req.limit));
  ipcMain.handle('git:diff', (_e, req: { cwd: string; ref?: string }) => gitDiff(req.cwd, req.ref));

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
    termPool.killAll();
  });

  // 启动动画（splash）：窗口以 show:false 创建，避免无边框窗口先闪白框。
  // renderer 首屏（App 挂载）后发 splash:done → 切淡出并 show()。
  // 仅「真冷启动」走此路径；托盘恢复走 showWindow()（win.show()），不经过此处。
  // 兜底：若渲染进程未在 3s 内通知（异常/未挂载），强制显示，避免窗口永远不可见。
  let splashDismissed = false;
  const dismissSplash = () => {
    if (splashDismissed) return;
    splashDismissed = true;
    if (!win.isDestroyed()) win.show();
  };
  ipcMain.on('splash:done', () => dismissSplash());
  const splashFallback = setTimeout(dismissSplash, 3000);
  win.on('closed', () => clearTimeout(splashFallback));

  // 常驻托盘在窗口就绪后创建（见 issue 01）。
  createTray(win);

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(createWindow);
// 窗口隐藏（非关闭）时应用保持存活；托盘常驻即入口，真正退出只经 before-quit
// （见 issue 04）。macOS 本就不退出，其余平台也不再因窗口"关闭"（实为隐藏）而退出。
app.on('window-all-closed', () => { /* 托盘常驻：不自动退出，仅 before-quit 触发真正退出 */ });
