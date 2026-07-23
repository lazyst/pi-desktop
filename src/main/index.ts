import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain, shell } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { UnifiedTerminalPool } from './unifiedTerminalPool';
import { SessionFileManager } from './sessionFileManager';
import type { IPtyLike } from './sessionPool';
import { listDir, readFile, writeFile, statFile, mkdir, createFile, rename, remove, copy, listNames, uniqueName, watchDir, watchFile } from './fsBridge';
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
import { detectTerminalProfiles } from './shellProfiles';

// 默认应用工作目录的绝对路径（仅 main 进程使用，有 node:os）。config.ts 因被
// renderer（sandbox，无 node:os）共享而不能 import node 模块，故在此用 node:os/path 计算。
// 文件夹名 ('defaultWorkSpace') 由 config.DEFAULT_APP_WORK_DIR_NAME 提供，保持单一来源。
function getDefaultAppWorkDir(): string {
  return path.join(os.homedir(), 'pi-desktop', 'defaultWorkSpace');
}import type { AppConfig, TerminalProfile } from '../renderer/src/types';

const configPath = () => path.join(os.homedir(), 'pi-desktop', 'config.json');
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

// 确保 config.appWorkDir 字段存在（旧配置/损坏时补全默认 ~/pi-desktop/defaultWorkSpace），
// 并创建该目录（递归），使「应用工作目录」分组下的集成终端 cwd 真实可用，
// 避免 integratedTerminalPool 的 safeCwd 因目录缺失而静默回退到 process.cwd()、导致分组语义失效。
function ensureAppWorkDir(): string {
  ensureLoaded();
  const cfg = configState!;
  // 旧配置/损坏时补全默认 ~/pi-desktop/defaultWorkSpace，并写回持久化（对齐 ADR §3 A1「自动填默认并写回」）。
  // config.ts 的 defaultConfig 只返回文件夹名（renderer 安全），此处补全为绝对路径。
  let dir = cfg.appWorkDir;
  if (!dir || !path.isAbsolute(dir)) {
    dir = getDefaultAppWorkDir();
    configState = mergeConfig(cfg, { appWorkDir: dir });
    writeConfigNow();
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error('[appWorkDir] failed to create dir:', dir, err);
  }
  return dir;
}

function ensureLoaded(): void {
  if (configState === undefined) configState = loadConfig();
}

function writeConfigNow(): void {
  if (!configState) return;
  try {
    const dir = path.dirname(configPath());
    fs.mkdirSync(dir, { recursive: true });
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
  // 应用工作目录变更：确保新目录已创建（递归），使该分组下的终端 cwd 立即可用。
  if (partial.appWorkDir) {
    // 确保传入的路径是绝对路径（renderer 可能只传了相对路径）
    const dir = partial.appWorkDir;
    const absDir = path.isAbsolute(dir) ? dir : path.join(os.homedir(), 'pi-desktop', dir);
    if (absDir !== dir) {
      configState = mergeConfig(configState!, { appWorkDir: absDir });
    }
    try { fs.mkdirSync(absDir, { recursive: true }); } catch (err) { console.error('[appWorkDir] failed to create dir:', absDir, err); }
  }
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
// 白闪根因：Windows 无边框窗口从隐藏到显示时，DWM 会在合成首帧前先用纯白填充
// 客户区，Electron 的 backgroundColor 时序上有时来不及，导致「最小化后再打开」出现一瞬白屏。
// 解法（透明桥接）：先以 opacity:0 显示，让白色首帧在不可见状态下绘制，
// 待下一帧（rAF）暗色内容已合成后再 setOpacity(1) 淡入——用户全程看不到白帧。
function showWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  // 冷启动(initial show:false)与恢复(hide 后 show)在此路径汇合：isVisible 均为 false。
  if (win.isVisible()) { win.focus(); return; }
  // 透明桥接：先以 opacity:0 显示，让 Windows DWM 在 show() 瞬间绘制的纯白首帧
  // 发生在不可见状态；待下一帧(~20ms)暗色 DOM 已合成后再 setOpacity(1) 淡入，
  // 用户全程看不到白帧。主进程是 Node 环境，无 requestAnimationFrame，故用 setTimeout。
  win.setOpacity(0);
  win.show();
  setTimeout(() => {
    if (win.isDestroyed()) return;
    win.setOpacity(1);
    win.focus();
  }, 20);
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

// SESSIONS_DIR 已由 resolveSessionsDir() 替代（见下方 createWindow）。

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

function resolveSessionsDir(): string {
  return process.env.PI_DESKTOP_SESSIONS_DIR ?? path.join(app.getPath('home'), '.pi', 'agent', 'sessions');
}

function createWindow() {
  // 确保 appWorkDir 已解析为绝对路径并已创建目录，避免 renderer 拿到相对路径后报错。
  ensureAppWorkDir();
  const cfg = getConfig();
  // 还原上次窗口几何（最大化状态单独存标志，bounds 永远是非最大化尺寸）。
  // show:false —— 启动动画（splash）由 renderer 首屏就绪后经 splash:done IPC 触发
  // show()，避免在「无边框窗口 + 内容异步加载」下先闪白框再显示内容（见 docs/adr/0003）。
  // backgroundColor 必须跟随主题设置：无边框窗口不指定时 OS 合成器默认给纯白背景，
  // 最小化为 hide() 后再 show() 会先闪一下亮白再被 React 暗色 DOM 覆盖（托盘恢复路径
  // 不经过 splash 遮挡）。取值与 index.html 的 --bg-app 回退色、theme.ts 的静态等价色一致，
  // 三处同源，杜绝亮闪。
  const win = new BrowserWindow({
    ...initialBoundsOptions(cfg.window.bounds),
    show: false,
    frame: false, // 无边框：原生菜单与标题条随之消失（任务 2），标题条改由渲染进程自建（任务 3）
    backgroundColor: cfg.theme === 'light' ? '#ffffff' : '#0d1117',
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
  //     http://localhost HMR）；其余 URL 一律拦截阻止窗口内导航。
  //
  // 注意：不再在此调 shell.openExternal——因为终端内链接已通过 xterm link 的 activate 回调
  // 走 app:openExternal IPC 打开（见 _registerTerminalLinkProvider），Markdown 预览链接也已
  // 通过 onClick 的 pi.openExternal 打开。will-navigate 仅作为安全措施阻止窗口内导航，
  // 不额外打开外部 URL，避免双重调用导致 Windows 弹出安全确认对话框。
  // 本项目未注册自定义 app:// 协议，生产以 file:// 加载，故放行集为 file:// + 本地 dev。
  // setWindowOpenHandler：拦截 window.open，对外部 URL 用系统命令在默认浏览器中打开。
  // 使用 child_process.exec 代替 shell.openExternal，
  // 避免 Electron 32 在 IPC/非用户手势上下文中可能弹出的安全确认对话框。
  // 终端链接的 activate 回调使用 window.open(url, '_blank') 保留用户手势上下文，
  // 这里拦截后直接走系统命令打开浏览器。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:')) {
      // 用 exec 打开 URL，彻底绕过 Electron 的 shell API 安全对话框
      const { exec } = require('child_process');
      const escaped = url.replace(/&/g, '^&');
      const cmd = process.platform === 'win32'
        ? `start "" "${escaped}"`
        : process.platform === 'darwin'
          ? `open '${escaped}'`
          : `xdg-open '${escaped}'`;
      exec(cmd, { shell: true }).catch(() => {});
    }
    // 一律 deny 新窗口：应用内不需要弹新窗口。
    return ({ action: 'deny' });
  });
  win.webContents.on('will-navigate', (e, url) => {
    const allowed =
      url.startsWith('file://') || // 生产 loadFile / 本地文件系统
      /^https?:\/\/localhost(:\d+)?\//.test(url); // 开发 Vite dev server（HMR）
    if (!allowed) {
      e.preventDefault();
      // 不再调 shell.openExternal（避免与各组件自身的 URL 打开逻辑重复，
      // 导致系统弹出安全确认对话框）。URL 打开由具体 handler 负责。
    }
  });

  // ===== 统一终端池 + 会话文件管理器 =====
  const sessionsDir = resolveSessionsDir();
  const sessionFileManager = new SessionFileManager(sessionsDir);
  const piBin = resolvePi();
  const unifiedPool = new UnifiedTerminalPool({
    cols: 80, rows: 24,
    piBin,
    sessionsDir,
    // 所有终端数据统一经 term:data 通道发送
    onData: (id, data) => { if (!win.isDestroyed()) win.webContents.send('term:data', { id, data }); },
    // pi 会话状态变更（running / dead），供侧边栏绿点更新
    onStatus: (key, status) => { if (!win.isDestroyed()) win.webContents.send('session:status', { key, status }); },
    // 所有终端退出统一经 term:exit 通道发送
    onExit: (id) => { if (!win.isDestroyed()) { win.webContents.send('term:exit', { id }); pushTerminalList(); } },
    onRelink: (from, to) => { if (!win.isDestroyed()) win.webContents.send('session:relink', { from, to }); },
    // 实例列表变化时推送
    onList: (list) => { if (!win.isDestroyed()) win.webContents.send('term:list', { list }); },
  });

  function pushTerminalList(): void {
    if (win.isDestroyed()) return;
    win.webContents.send('term:list', { list: unifiedPool.list() });
  }

  // ===== 统一终端 IPC =====
  // terminal:spawn — 创建终端（pi 会话或 shell 终端，由 SpawnOptions.command 区分）
  ipcMain.handle('terminal:spawn', async (_e, req: { command?: string; cwd: string; profile?: TerminalProfile; sessionFile?: string; name?: string; key?: string }) => {
    try {
      const info = unifiedPool.create(req);
      pushTerminalList();
      return info;
    } catch (err) {
      console.error('[terminal:spawn] failed:', err);
      throw new Error('无法启动终端，请确认 pi 或 shell 可用');
    }
  });
  // terminal:listProfiles — 列出可用 shell profile
  ipcMain.handle('terminal:listProfiles', () => detectTerminalProfiles());
  // terminal:list — 旧版列出所有终端（保留向后兼容）
  ipcMain.handle('terminal:list', () => unifiedPool.list());
  // terminal:create — 旧版集成终端创建入口（先保留，App.tsx 仍在使用）
  ipcMain.handle('terminal:create', (_e, req: { profile: TerminalProfile; cwd: string }) => {
    try {
      const info = unifiedPool.create({ command: undefined, cwd: req.cwd, profile: req.profile });
      pushTerminalList();
      return info;
    } catch (err) {
      console.error('[terminal:create] failed:', err);
      throw new Error('无法启动集成终端');
    }
  });
  // terminal:createInAppWorkDir — 旧版，在工作目录创建
  ipcMain.handle('terminal:createInAppWorkDir', (_e, req: { profile: TerminalProfile }) => {
    try {
      const cwd = ensureAppWorkDir();
      const info = unifiedPool.create({ command: undefined, cwd, profile: req.profile });
      pushTerminalList();
      return info;
    } catch (err) {
      console.error('[terminal:createInAppWorkDir] failed:', err);
      throw new Error('无法在应用工作目录启动集成终端');
    }
  });
  // terminal:input — 键盘输入
  ipcMain.on('terminal:input', (_e, m: { id: string; data: string }) => unifiedPool.write(m.id, m.data));
  // terminal:resize — 调整尺寸
  ipcMain.on('terminal:resize', (_e, m: { id: string; cols: number; rows: number }) => unifiedPool.resize(m.id, m.cols, m.rows));
  // terminal:ack — 背压回传
  ipcMain.on('terminal:ack', (_e, m: { id: string; bytes: number }) => unifiedPool.acknowledgeDataEvent(m.id, m.bytes));
  // terminal:destroy — 销毁终端（用于 shell 终端，直接按 id 杀）
  ipcMain.handle('terminal:destroy', (_e, id: string) => { unifiedPool.destroy(id); pushTerminalList(); });
  // session:terminate — 终止 pi 会话（保留别名，含 live key 反查，侧边栏传入 .jsonl 路径）
  ipcMain.handle('session:terminate', (_e, key: string) => { unifiedPool.terminate(key); pushTerminalList(); });

  // 滚动缓冲区持久化（内存暂存）
  const terminalBuffers = new Map<string, string>();
  ipcMain.on('terminal:saveBuffer', (_e, m: { id: string; data: string }) => {
    if (m?.id && typeof m.data === 'string') terminalBuffers.set(m.id, m.data);
  });
  ipcMain.handle('terminal:loadBuffer', (_e, id: string): string | undefined => terminalBuffers.get(id));
  // terminal:updateCwd — shell integration cwd 更新（仅 shell 类型有效）
  ipcMain.on('terminal:updateCwd', (_e, m: { id: string; cwd: string }) => {
    unifiedPool.updateCwd(m.id, m.cwd);
    pushTerminalList();
  });

  // 受控外部链接通道：渲染层经此桥请求打开外部程序（系统浏览器/mail 客户端）。
  // file:// 不走此通道，二进制/本地文件由 fs:openWithSystem（shell.openPath）以系统程序打开。
  // 以免绕过路径越界保护。自用工具，不打扰确认，直接开。
  ipcMain.handle('app:openExternal', (_e, url: string): boolean => {
    if (typeof url !== 'string' || !url) return false;
    let u: URL;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'mailto:') {
      return false;
    }
    // 用 exec 替代 shell.openExternal，避免 Electron 32 的安全确认对话框
    const { exec } = require('child_process');
    const escaped = url.replace(/&/g, '^&');
    const cmd = process.platform === 'win32'
      ? `start "" "${escaped}"`
      : process.platform === 'darwin'
        ? `open '${escaped}'`
        : `xdg-open '${escaped}'`;
    exec(cmd, { shell: true }).catch(() => {});
    return true;
  });

  // 用系统默认程序打开本地文件（二进制/无内置预览器的文件，如 pdf/exe/zip/docx 等）。
  // 走 shell.openPath（等同于在系统文件管理器双击文件），不走 app:openExternal
  // 的协议白名单（那里 file:// 被拒）。路径由渲染层以绝对路径传入，已受 fsBridge
  // 的 root bounds-check 约束（fsReadFile 同根），不存在越界风险。
  ipcMain.handle('fs:openWithSystem', async (_e, absPath: string): Promise<boolean> => {
    if (typeof absPath !== 'string' || !absPath) return false;
    try { await shell.openPath(absPath); return true; }
    catch { return false; }
  });

  // ╌╌ pi-tool 集成：模型配置、MCP、Skills、扩展、Pi 配置 ╌╌

  /** 深度合并 source 到 target（仅对象，数组直接替换） */
  function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = { ...target };
    for (const key of Object.keys(source)) {
      const sv = source[key];
      const tv = result[key];
      if (sv !== null && typeof sv === 'object' && !Array.isArray(sv) &&
          tv !== null && typeof tv === 'object' && !Array.isArray(tv)) {
        result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
      } else {
        result[key] = sv;
      }
    }
    return result;
  }

  // Pi 配置文件 (~/.pi/agent/settings.json)
  const piAgentDir = path.join(os.homedir(), '.pi', 'agent');

  ipcMain.handle('pi:settings:get', (_e, scope: 'global' | 'project') => {
    const settingsPath = scope === 'project'
      ? path.join(process.cwd(), '.pi', 'settings.json')
      : path.join(piAgentDir, 'settings.json');
    const exists = fs.existsSync(settingsPath);
    let data: unknown = null;
    let raw = '';
    if (exists) {
      raw = fs.readFileSync(settingsPath, 'utf-8');
      try { data = JSON.parse(raw); } catch { /* 不合法 JSON 也能编辑 */ }
    }
    return { data, raw, path: settingsPath, exists };
  });

  ipcMain.handle('pi:settings:set', (_e, payload: { scope: 'global' | 'project'; data?: Record<string, unknown>; raw?: string }) => {
    const settingsPath = payload.scope === 'project'
      ? path.join(process.cwd(), '.pi', 'settings.json')
      : path.join(piAgentDir, 'settings.json');
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (payload.raw !== undefined) {
      // 源文件模式：直接写 raw 字符串
      fs.writeFileSync(settingsPath, payload.raw, 'utf-8');
    } else if (payload.data !== undefined) {
      // 表单模式：深度合并到现有配置
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(settingsPath)) {
        try { existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { /* 忽略损坏的现有文件 */ }
      }
      const merged = deepMerge(existing, payload.data);
      fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    }
    return { success: true, path: settingsPath };
  });

  // 模型配置 (~/.pi/agent/models.json)
  const modelsPath = path.join(piAgentDir, 'models.json');

  ipcMain.handle('pi:models:get', () => {
    if (fs.existsSync(modelsPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
        return data;
      } catch { /* fall through */ }
    }
    return { providers: {} };
  });

  ipcMain.handle('pi:models:set', (_e, data: unknown) => {
    if (!fs.existsSync(piAgentDir)) fs.mkdirSync(piAgentDir, { recursive: true });
    fs.writeFileSync(modelsPath, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true };
  });

  // MCP 管理
  ipcMain.handle('pi:mcp:configs', () => {
    const cwd = process.cwd();
    const home = os.homedir();
    const files = [
      { id: 'user-global', label: '用户全局配置 (Shared)', path: path.join(home, '.config', 'mcp', 'mcp.json') },
      { id: 'pi-global', label: 'Pi 全局覆盖 (Pi Agent)', path: path.join(piAgentDir, 'mcp.json') },
      { id: 'project-shared', label: '项目共享 (Project)', path: path.join(cwd, '.mcp.json') },
      { id: 'project-pi', label: 'Pi 项目覆盖 (Project Pi)', path: path.join(cwd, '.pi', 'mcp.json') },
    ];
    return files.map(f => {
      const exists = fs.existsSync(f.path);
      let config: unknown = null;
      if (exists) {
        try { config = JSON.parse(fs.readFileSync(f.path, 'utf-8')); } catch { /* empty */ }
      }
      return { ...f, exists, config };
    });
  });

  ipcMain.handle('pi:mcp:configs:save', (_e, payload: { id: string; config: unknown }) => {
    const home = os.homedir();
    const cwd = process.cwd();
    const fileDefs: Record<string, string> = {
      'user-global': path.join(home, '.config', 'mcp', 'mcp.json'),
      'pi-global': path.join(piAgentDir, 'mcp.json'),
      'project-shared': path.join(cwd, '.mcp.json'),
      'project-pi': path.join(cwd, '.pi', 'mcp.json'),
    };
    const filePath = fileDefs[payload.id];
    if (!filePath) throw new Error('Unknown MCP config: ' + payload.id);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload.config, null, 2), 'utf-8');
    return { success: true, path: filePath };
  });

  ipcMain.handle('pi:mcp:status', () => {
    const locations = [
      path.join(piAgentDir, 'npm', 'node_modules', 'pi-mcp-adapter', 'package.json'),
      path.join(piAgentDir, 'node_modules', 'pi-mcp-adapter', 'package.json'),
    ];
    for (const loc of locations) {
      if (fs.existsSync(loc)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(loc, 'utf-8'));
          return { installed: true, version: pkg.version };
        } catch { /* ignore */ }
      }
    }
    return { installed: false };
  });

  // Skills 管理
  const skillsDir = path.join(piAgentDir, 'skills');
  const disabledSkillsDir = path.join(piAgentDir, 'skills', '.disabled');

  function listSkills(): Array<{ name: string; dir: string; disabled: boolean; description?: string }> {
    const result: Array<{ name: string; dir: string; disabled: boolean; description?: string }> = [];
    if (fs.existsSync(skillsDir)) {
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const skillDir = path.join(skillsDir, entry.name);
          const skillMd = path.join(skillDir, 'SKILL.md');
          let description: string | undefined;
          if (fs.existsSync(skillMd)) {
            const content = fs.readFileSync(skillMd, 'utf-8');
            const match = content.match(/description:\s*"([^"]+)"|description:\s*([^\r\n]+)/);
            description = match?.[1] || match?.[2]?.trim() || undefined;
          }
          result.push({ name: entry.name, dir: skillDir, disabled: false, description });
        }
      }
    }
    if (fs.existsSync(disabledSkillsDir)) {
      for (const entry of fs.readdirSync(disabledSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const skillDir = path.join(disabledSkillsDir, entry.name);
          const skillMd = path.join(skillDir, 'SKILL.md');
          let description: string | undefined;
          if (fs.existsSync(skillMd)) {
            const content = fs.readFileSync(skillMd, 'utf-8');
            const match = content.match(/description:\s*"([^"]+)"|description:\s*([^\r\n]+)/);
            description = match?.[1] || match?.[2]?.trim() || undefined;
          }
          result.push({ name: entry.name, dir: skillDir, disabled: true, description });
        }
      }
    }
    return result;
  }

  ipcMain.handle('pi:skills:list', () => ({ skills: listSkills() }));

  ipcMain.handle('pi:skills:disable', (_e, name: string) => {
    const src = path.join(skillsDir, name);
    const dst = path.join(disabledSkillsDir, name);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return { success: false, error: 'Skill not found' };
    if (!fs.existsSync(disabledSkillsDir)) fs.mkdirSync(disabledSkillsDir, { recursive: true });
    fs.renameSync(src, dst);
    return { success: true };
  });

  ipcMain.handle('pi:skills:enable', (_e, name: string) => {
    const src = path.join(disabledSkillsDir, name);
    const dst = path.join(skillsDir, name);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return { success: false, error: 'Disabled skill not found' };
    fs.renameSync(src, dst);
    return { success: true };
  });

  ipcMain.handle('pi:skills:delete', (_e, name: string) => {
    const normal = path.join(skillsDir, name);
    const disabled = path.join(disabledSkillsDir, name);
    if (fs.existsSync(normal)) {
      fs.rmSync(normal, { recursive: true, force: true });
      return { success: true };
    }
    if (fs.existsSync(disabled)) {
      fs.rmSync(disabled, { recursive: true, force: true });
      return { success: true };
    }
    return { success: false, error: 'Skill not found' };
  });

  // 扩展管理
  const extDir = path.join(piAgentDir, 'extensions');
  const disabledExtDir = path.join(piAgentDir, 'extensions', '.disabled');

  function getPackageSourceString(pkg: unknown): string {
    if (typeof pkg === 'string') return pkg;
    if (pkg && typeof pkg === 'object') {
      const s = (pkg as Record<string, unknown>).source;
      return typeof s === 'string' ? s : '';
    }
    return '';
  }

  function getPackageDisplayName(source: string): string {
    if (source.startsWith('npm:')) return source.slice(4);
    if (source.startsWith('git:')) {
      const parts = source.split('/');
      return parts[parts.length - 1] || source;
    }
    return path.basename(source.replace(/\\/g, '/'));
  }

  function readSettingsPackages(settingPath: string): { packages: unknown[]; extensions: string[] } {
    if (!fs.existsSync(settingPath)) return { packages: [], extensions: [] };
    try {
      const data = JSON.parse(fs.readFileSync(settingPath, 'utf-8'));
      return {
        packages: Array.isArray(data.packages) ? data.packages : [],
        extensions: Array.isArray(data.extensions) ? data.extensions : [],
      };
    } catch {
      return { packages: [], extensions: [] };
    }
  }

  function readPiToolState(): Record<string, unknown> {
    const statePath = path.join(piAgentDir, 'pi-tool-state.json');
    if (fs.existsSync(statePath)) {
      try { return JSON.parse(fs.readFileSync(statePath, 'utf-8')); } catch { /* empty */ }
    }
    return {};
  }

  function writePiToolState(state: Record<string, unknown>): void {
    fs.writeFileSync(path.join(piAgentDir, 'pi-tool-state.json'), JSON.stringify(state, null, 2), 'utf-8');
  }

  ipcMain.handle('pi:extensions:list', () => {
    const result: Array<{ name: string; type: string; source: string; disabled: boolean; managed: boolean; dir?: string }> = [];

    // 本地目录扩展
    if (fs.existsSync(extDir)) {
      for (const entry of fs.readdirSync(extDir, { withFileTypes: true })) {
        if (!entry.name.startsWith('.') && (entry.isDirectory() || entry.isFile())) {
          result.push({ name: entry.name, type: 'local', source: path.join(extDir, entry.name), disabled: false, managed: true, dir: path.join(extDir, entry.name) });
        }
      }
    }
    if (fs.existsSync(disabledExtDir)) {
      for (const entry of fs.readdirSync(disabledExtDir, { withFileTypes: true })) {
        if (!entry.name.startsWith('.') && (entry.isDirectory() || entry.isFile())) {
          result.push({ name: entry.name, type: 'local', source: path.join(disabledExtDir, entry.name), disabled: true, managed: true, dir: path.join(disabledExtDir, entry.name) });
        }
      }
    }

    // 包扩展
    const globalSettingsPath = path.join(piAgentDir, 'settings.json');
    const projectSettingsPath = path.join(process.cwd(), '.pi', 'settings.json');
    const globalPkgs = readSettingsPackages(globalSettingsPath);
    const projectPkgs = readSettingsPackages(projectSettingsPath);
    const state = readPiToolState();
    const disabledPackages: string[] = (state.disabledExtensions as string[]) || [];

    const seenPkgSources = new Set<string>();
    for (const pkg of [...globalPkgs.packages, ...projectPkgs.packages]) {
      const source = getPackageSourceString(pkg);
      if (!source || seenPkgSources.has(source)) continue;
      seenPkgSources.add(source);
      result.push({ name: getPackageDisplayName(source), type: 'package', source, disabled: disabledPackages.includes(source), managed: true });
    }
    for (const source of disabledPackages) {
      if (seenPkgSources.has(source)) continue;
      seenPkgSources.add(source);
      result.push({ name: getPackageDisplayName(source), type: 'package', source, disabled: true, managed: true });
    }

    return { extensions: result };
  });

  ipcMain.handle('pi:extensions:disable', (_e, payload: { name: string; type: string; source: string; dir?: string }) => {
    if (payload.type === 'local' && payload.dir) {
      const src = payload.dir;
      const dst = path.join(disabledExtDir, payload.name);
      if (!fs.existsSync(src)) return { success: false, error: 'Extension not found' };
      if (!fs.existsSync(disabledExtDir)) fs.mkdirSync(disabledExtDir, { recursive: true });
      fs.renameSync(src, dst);
      return { success: true };
    }
    if (payload.type === 'package') {
      // 从 settings.json 移除
      const settingsPaths = [path.join(piAgentDir, 'settings.json'), path.join(process.cwd(), '.pi', 'settings.json')];
      let changed = false;
      for (const sp of settingsPaths) {
        if (fs.existsSync(sp)) {
          try {
            const settings = JSON.parse(fs.readFileSync(sp, 'utf-8'));
            if (Array.isArray(settings.packages)) {
              const before = settings.packages.length;
              settings.packages = settings.packages.filter((p: unknown) => getPackageSourceString(p) !== payload.source);
              if (settings.packages.length !== before) {
                changed = true;
                fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
              }
            }
          } catch { /* empty */ }
        }
      }
      if (changed) {
        const st = readPiToolState();
        const list: string[] = (st.disabledExtensions as string[]) || [];
        if (!list.includes(payload.source)) {
          list.push(payload.source);
          st.disabledExtensions = list;
          writePiToolState(st);
        }
      }
      return { success: changed };
    }
    return { success: false, error: 'Unsupported extension type' };
  });

  ipcMain.handle('pi:extensions:enable', (_e, payload: { name: string; type: string; source: string; dir?: string }) => {
    if (payload.type === 'local' && payload.dir) {
      const src = payload.dir;
      const dst = path.join(extDir, payload.name);
      if (!fs.existsSync(src)) return { success: false, error: 'Extension not found' };
      if (!fs.existsSync(extDir)) fs.mkdirSync(extDir, { recursive: true });
      fs.renameSync(src, dst);
      return { success: true };
    }
    if (payload.type === 'package') {
      const st = readPiToolState();
      const list: string[] = (st.disabledExtensions as string[]) || [];
      const idx = list.indexOf(payload.source);
      if (idx === -1) return { success: false, error: 'Extension not found in disabled list' };
      list.splice(idx, 1);
      st.disabledExtensions = list;
      writePiToolState(st);
      // 写回 settings.json
      const globalSettingsPath = path.join(piAgentDir, 'settings.json');
      try {
        const settings = fs.existsSync(globalSettingsPath)
          ? JSON.parse(fs.readFileSync(globalSettingsPath, 'utf-8'))
          : {};
        if (!Array.isArray(settings.packages)) settings.packages = [];
        if (!settings.packages.includes(payload.source)) {
          settings.packages.push(payload.source);
          const dir = path.dirname(globalSettingsPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(globalSettingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
        }
        return { success: true };
      } catch {
        return { success: false, error: 'Failed to write settings' };
      }
    }
    return { success: false, error: 'Unsupported extension type' };
  });

  ipcMain.handle('pi:extensions:delete', (_e, payload: { name: string; type: string; source: string; dir?: string }) => {
    if (payload.type === 'local' && payload.dir) {
      if (!fs.existsSync(payload.dir)) return { success: false, error: 'Extension not found' };
      fs.rmSync(payload.dir, { recursive: true, force: true });
      return { success: true };
    }
    if (payload.type === 'package') {
      const settingsPaths = [path.join(piAgentDir, 'settings.json'), path.join(process.cwd(), '.pi', 'settings.json')];
      let changed = false;
      for (const sp of settingsPaths) {
        if (fs.existsSync(sp)) {
          try {
            const settings = JSON.parse(fs.readFileSync(sp, 'utf-8'));
            if (Array.isArray(settings.packages)) {
              const before = settings.packages.length;
              settings.packages = settings.packages.filter((p: unknown) => getPackageSourceString(p) !== payload.source);
              if (settings.packages.length !== before) {
                changed = true;
                fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
              }
            }
          } catch { /* empty */ }
        }
      }
      if (changed) {
        const st = readPiToolState();
        const list: string[] = (st.disabledExtensions as string[]) || [];
        const idx = list.indexOf(payload.source);
        if (idx !== -1) {
          list.splice(idx, 1);
          st.disabledExtensions = list;
          writePiToolState(st);
        }
      }
      return { success: changed };
    }
    return { success: false, error: 'Unsupported extension type' };
  });

  // 在系统文件管理器中打开文件/目录所在位置并选中（等同资源管理器"打开所在文件夹"）。
  // 文件：打开父目录并高亮该文件；目录：直接打开该
  ipcMain.handle('fs:showInFolder', async (_e, absPath: string): Promise<boolean> => {
    if (typeof absPath !== 'string' || !absPath) return false;
    try { shell.showItemInFolder(absPath); return true; }
    catch { return false; }
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
    // 主题切换时同步窗口合成背景色，使最小化/托盘恢复（hide→show）不再闪亮
    // （backgroundColor 与 --bg-app / theme.ts 静态色同源）。
    if (partial.theme && (partial.theme === 'light' || partial.theme === 'dark')) {
      if (!win.isDestroyed()) win.setBackgroundColor(partial.theme === 'light' ? '#ffffff' : '#0d1117');
    }
    if (!win.isDestroyed()) win.webContents.send('config:change', getConfig());
  });

  // ===== 会话文件管理 IPC（session:*） =====
  // 会话写盘（用户发首条消息后 pi 写出 .jsonl）即视为"晋升"，推送最新索引给渲染进程。
  // 300ms debounce 合并突发写入。recursive watch 在 Windows/macOS 原生支持。
  let indexTimer: ReturnType<typeof setTimeout> | undefined;
  const pushIndex = () => {
    if (indexTimer) clearTimeout(indexTimer);
    indexTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const groups = sessionFileManager.listFiles();
      // Link freshly-written disk sessions to the live processes that created them
      // so clicking a promoted sidebar entry reuses the same process.
      unifiedPool.reconcile(groups);
      win.webContents.send('session:index', groups);
    }, 300);
  };
  try {
    fs.watch(sessionsDir, { recursive: true }, pushIndex);
  } catch (err) {
    console.error('[session:index] fs.watch failed:', err);
  }

  ipcMain.handle('session:list', () => sessionFileManager.listFiles());
  ipcMain.handle('session:delete', (_e, key: string) => {
    sessionFileManager.deleteSession(key);
    unifiedPool.terminate(key); // 同时杀掉运行中的进程（如有）
    pushIndex();
  });
  ipcMain.handle('session:deleteMany', (_e, keys: string[]) => {
    sessionFileManager.deleteMany(keys);
    for (const k of keys) unifiedPool.terminate(k);
    pushIndex();
  });
  ipcMain.handle('session:clearDirectory', (_e, cwd: string) => {
    // 先杀掉该 cwd 下所有运行中的 pi 会话
    for (const t of unifiedPool.list()) {
      if (t.cwd === cwd && t.type === 'pi') unifiedPool.terminate(t.id);
    }
    sessionFileManager.clearDirectory(cwd);
    pushIndex();
  });
  ipcMain.handle('session:debug', () => sessionFileManager.debugInfo(unifiedPool['entries'] as any));
  ipcMain.handle('session:pickDirectory', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  // session:saveImage — 图片粘贴落盘（保持不变）
  ipcMain.handle('session:saveImage', (_e, payload: { data: string; ext: string }) => {
    try {
      if (!payload || typeof payload.data !== 'string' || !payload.data) return null;
      const ext = (payload.ext || 'png').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'png';
      const tmpDir = app.getPath('temp');
      const name = `pi-paste-${crypto.randomUUID()}.${ext}`;
      const filePath = path.join(tmpDir, name);
      const buf = Buffer.from(payload.data, 'base64');
      fs.writeFileSync(filePath, buf);
      return filePath;
    } catch (err) {
      console.error('[session:saveImage] failed:', err);
      return null;
    }
  });

  // ── 文件管理器（A + B 预览）只读/写 IPC ──
  // 注意：路径越权校验（allowedRoots / resolveSafe）已按产品决策整体移除，
  // 文件操作直接信任渲染端传入的 root + relPath。
  ipcMain.handle('fs:listDir', (_e, req: { root: string; dir: string }) =>
    listDir(req.root, req.dir));
  // ╌╌ 目录监听（外部变更自动刷新，对齐 VS Code FileWatcher）╌╌
  // 渲染端请求监控某个目录（root + dir），主进程起 fs.watch；该目录的直接子项
  // 发生增删时，经 'fs:change' 通道推送 { dir } 给渲染端，由其刷新对应目录。
  // 同一目录可能被渲染端多次订阅（多个 TreeNode 共享父目录）；用计数实现引用计数，
  // 最后一处取消时才真正关闭底层 watcher，避免重复句柄。
  const dirWatchers = new Map<string, { stop: () => void; refs: number }>();
  const watchKey = (root: string, dir: string) => `${root} ${dir}`;
  ipcMain.on('fs:watch', (_e, req: { root: string; dir: string }) => {
    const key = watchKey(req.root, req.dir);
    const existing = dirWatchers.get(key);
    if (existing) {
      existing.refs += 1;
      return;
    }
    const stop = watchDir(req.root, req.dir, (_filename) => {
      if (!win.isDestroyed()) win.webContents.send('fs:change', { dir: req.dir });
    });
    dirWatchers.set(key, { stop, refs: 1 });
  });
  ipcMain.on('fs:unwatch', (_e, req: { root: string; dir: string }) => {
    const key = watchKey(req.root, req.dir);
    const entry = dirWatchers.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) {
      entry.stop();
      dirWatchers.delete(key);
    }
  });

  // ╌╌ 文件监听（外部修改自动刷新编辑器）╌╌
  // 渲染端请求监控某个文件（root + path），主进程起 fs.watch 监听其所在目录，
  // 当匹配到该文件变更时，经 'fs:fileChange' 通道推送 { root, path } 给渲染端。
  // 使用引用计数，最后一处取消时才真正关闭底层 watcher。
  const fileWatchers = new Map<string, { stop: () => void; refs: number }>();
  const fileWatchKey = (root: string, path: string) => `${root} ${path}`;
  ipcMain.on('fs:watchFile', (_e, req: { root: string; path: string }) => {
    const key = fileWatchKey(req.root, req.path);
    const existing = fileWatchers.get(key);
    if (existing) {
      existing.refs += 1;
      return;
    }
    const stop = watchFile(req.root, req.path, () => {
      if (!win.isDestroyed()) win.webContents.send('fs:fileChange', { root: req.root, path: req.path });
    });
    fileWatchers.set(key, { stop, refs: 1 });
  });
  ipcMain.on('fs:unwatchFile', (_e, req: { root: string; path: string }) => {
    const key = fileWatchKey(req.root, req.path);
    const entry = fileWatchers.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) {
      entry.stop();
      fileWatchers.delete(key);
    }
  });
  ipcMain.handle('fs:readFile', (_e, req: { root: string; path: string; maxBytes?: number }) =>
    readFile(req.root, req.path, req.maxBytes));
  ipcMain.handle('fs:writeFile', (_e, req: { root: string; path: string; content: string }) =>
    writeFile(req.root, req.path, req.content));
  ipcMain.handle('fs:stat', (_e, req: { root: string; path: string }) =>
    statFile(req.root, req.path));

  // ── 文件管理写操作（新建 / 重命名 / 删除 / 复制 / 移动）──
  ipcMain.handle('fs:mkdir', (_e, req: { root: string; dir: string }) =>
    mkdir(req.root, req.dir));
  ipcMain.handle('fs:createFile', (_e, req: { root: string; path: string; content?: string }) =>
    createFile(req.root, req.path, req.content ?? ''));
  ipcMain.handle('fs:rename', (_e, req: { root: string; from: string; to: string }) =>
    rename(req.root, req.from, req.to));
  ipcMain.handle('fs:remove', (_e, req: { root: string; path: string }) =>
    remove(req.root, req.path));
  ipcMain.handle('fs:copy', (_e, req: { root: string; from: string; to: string }) =>
    copy(req.root, req.from, req.to));
  ipcMain.handle('fs:listNames', (_e, req: { root: string; dir: string }) =>
    listNames(req.root, req.dir));
  // 计算不重名的名字（重名时自动加 (1) 后缀），纯计算、无需落盘。
  ipcMain.handle('fs:uniqueName', (_e, req: { base: string; existing: string[] }) =>
    uniqueName(req.base, new Set(req.existing)));

  // ── Git 只读查看（D）── 非 git 目录优雅降级（见 gitBridge，永不抛错）。
  ipcMain.handle('git:status', (_e, req: { cwd: string }) => gitStatus(req.cwd));
  ipcMain.handle('git:log', (_e, req: { cwd: string; limit?: number }) => gitLog(req.cwd, req.limit));
  ipcMain.handle('git:diff', (_e, req: { cwd: string; ref?: string }) => gitDiff(req.cwd, req.ref));
  // ── Git 工作区实时监听（事件驱动刷新，对齐 VS Code FileWatcher）──
  // 渲染端订阅某仓库 cwd，主进程以 recursive 监听整个仓库目录（含子目录改动与
  // .git/ 内 index/ref 变更），任意变更即经 'git:change' 推送 { cwd } 让渲染端刷新。
  // 同一 cwd 可能被多处订阅（GitView + 打开中的 GitDiffDrawer），用引用计数管理，
  // 最后一处取消才真正关闭底层 watcher，避免重复句柄。
  const gitWatchers = new Map<string, { stop: () => void; refs: number }>();
  ipcMain.on('git:watch', (_e, req: { cwd: string }) => {
    const cwd = req.cwd;
    const existing = gitWatchers.get(cwd);
    if (existing) {
      existing.refs += 1;
      return;
    }
    let watcher: fs.FSWatcher | undefined;
    let closed = false;
    const stop = () => {
      if (closed) return;
      closed = true;
      try { watcher?.close(); } catch { /* 已关闭，忽略 */ }
    };
    try {
      watcher = fs.watch(cwd, { recursive: true }, () => {
        if (!win.isDestroyed()) win.webContents.send('git:change', { cwd });
      });
      watcher.on('error', () => stop());
    } catch {
      // 目录不存在/无权限：降级为 no-op（仓库可能尚未就绪）。
      return;
    }
    gitWatchers.set(cwd, { stop, refs: 1 });
  });
  ipcMain.on('git:unwatch', (_e, req: { cwd: string }) => {
    const entry = gitWatchers.get(req.cwd);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) {
      entry.stop();
      gitWatchers.delete(req.cwd);
    }
  });

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
  // 任务栏最小化→点任务栏图标恢复（OS 原生 restore，绕过 showWindow 的透明桥接）
  // 同样会触发 DWM 白首帧，故在 restore 瞬间用 opacity 0→1 桥接吃掉白闪。
  // 仅当窗口确实刚从隐藏恢复时才桥接（isVisible 在 restore 事件触发时已为 true，
  // 故用 'restore' 事件本身即代表发生了隐藏→显示，直接桥接一次即可）。
  win.on('restore', () => {
    if (win.isDestroyed()) return;
    win.setOpacity(0);
    setTimeout(() => {
      if (win.isDestroyed()) return;
      win.setOpacity(1);
    }, 20);
  });

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
    unifiedPool.killAll();
  });

  // 启动动画（splash）：窗口以 show:false 创建，避免无边框窗口先闪白框。
  // renderer 首屏（App 挂载）后发 splash:done → 切淡出并 show()。
  // 仅「真冷启动」走此路径；托盘恢复走 showWindow()。两处都经 showWindow 的
  // 透明(opacity 0→1)桥接，统一吞掉 show() 瞬间的 OS 合成白首帧（见 showWindow）。
  // 兜底：若渲染进程未在 3s 内通知（异常/未挂载），强制显示，避免窗口永远不可见。
  let splashDismissed = false;
  const dismissSplash = () => {
    if (splashDismissed) return;
    splashDismissed = true;
    if (!win.isDestroyed()) showWindow(win);
  };
  ipcMain.on('splash:done', () => dismissSplash());
  const splashFallback = setTimeout(dismissSplash, 3000);
  win.on('closed', () => clearTimeout(splashFallback));

  // 常驻托盘在窗口就绪后创建（见 issue 01）。
  createTray(win);

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // 已有实例在运行，直接退出新启动的副本。
  app.quit();
} else {
  // 当用户再次打开应用时，聚焦到已有窗口（托盘隐藏场景也适用）。
  app.on('second-instance', () => {
    const [existingWin] = BrowserWindow.getAllWindows();
    if (existingWin) {
      if (existingWin.isMinimized()) existingWin.restore();
      existingWin.show();
      existingWin.focus();
    }
  });

  app.whenReady().then(createWindow);
}

// 窗口隐藏（非关闭）时应用保持存活；托盘常驻即入口，真正退出只经 before-quit
// （见 issue 04）。macOS 本就不退出，其余平台也不再因窗口"关闭"（实为隐藏）而退出。
app.on('window-all-closed', () => { /* 托盘常驻：不自动退出，仅 before-quit 触发真正退出 */ });
