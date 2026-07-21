import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { OpenRequest, SessionGroup, SessionInfo, SessionStatus, AppConfig, TerminalProfile, IntegratedTerminalInfo } from '../renderer/src/types';

// 读取主进程经 webPreferences.additionalArguments 同步注入的初始 config（窗口创建时
// 即确定，无需等待异步 IPC），供渲染进程首屏零闪烁地拿到主题等初始值。
function readInitialConfig(): AppConfig | null {
  try {
    const arg = process.argv.find((a) => a.startsWith('--pi-initial-config='));
    if (!arg) return null;
    return JSON.parse(decodeURIComponent(arg.slice('--pi-initial-config='.length))) as AppConfig;
  } catch {
    return null;
  }
}
const initialConfig = readInitialConfig();

contextBridge.exposeInMainWorld('pi', {
  listSessions: (): Promise<SessionGroup[]> => ipcRenderer.invoke('session:list'),
  openSession: (req: OpenRequest): Promise<SessionInfo> =>
    ipcRenderer.invoke('terminal:spawn', { command: 'pi', cwd: req.cwd ?? '', sessionFile: req.key?.endsWith('.jsonl') ? req.key : undefined, key: req.key && !req.key.endsWith('.jsonl') ? req.key : undefined, name: req.name }),
  terminate: (key: string): Promise<void> => ipcRenderer.invoke('session:terminate', key),  // 调用 session:terminate（main 中 UnifiedTerminalPool.terminate）
  deleteSession: (key: string): Promise<void> => ipcRenderer.invoke('session:delete', key),
  deleteMany: (keys: string[]): Promise<void> => ipcRenderer.invoke('session:deleteMany', keys),
  clearDirectory: (cwd: string): Promise<void> => ipcRenderer.invoke('session:clearDirectory', cwd),
  input: (key: string, data: string) => ipcRenderer.send('terminal:input', { id: key, data }),
  resize: (key: string, cols: number, rows: number) => ipcRenderer.send('terminal:resize', { id: key, cols, rows }),
  debug: (): Promise<{ count: number; pids: number[] }> => ipcRenderer.invoke('session:debug'),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('session:pickDirectory'),
  // 拖拽文件落终端：把渲染端拖入的 File 解析为绝对路径。
  // Electron 31+ 起 File.path 已弃用，官方改用 webUtils.getPathForFile（同步返回绝对路径）；
  // 若该 API 因传入非原生拖拽 File 而失败，回退到 File.path（测试/旧环境注入的绝对路径）。
  getPathForFile: (file: File): string => {
    try {
      const p = webUtils.getPathForFile(file);
      if (p) return p;
    } catch {
      /* 非原生拖拽 File（如测试构造）：回退下面 */
    }
    return (file as any).path ?? '';
  },
  // 图片粘贴落盘：渲染端把剪贴板里的图片读成 base64 传来，主进程写临时文件并返回绝对路径。
  saveImage: (data: string, ext: string): Promise<string | null> =>
    ipcRenderer.invoke('session:saveImage', { data, ext }),
  onData: (cb: (key: string, data: string) => void) => {
    const handler = (_e: unknown, m: { id: string; data: string }) => cb(m.id, m.data);
    ipcRenderer.on('term:data', handler);
    return () => ipcRenderer.removeListener('term:data', handler);
  },
  onStatus: (cb: (key: string, status: SessionStatus) => void) => {
    const handler = (_e: unknown, m: { key: string; status: SessionStatus }) => cb(m.key, m.status);
    ipcRenderer.on('session:status', handler);
    return () => ipcRenderer.removeListener('session:status', handler);
  },
  onExit: (cb: (key: string) => void) => {
    const handler = (_e: unknown, m: { id: string }) => cb(m.id);
    ipcRenderer.on('term:exit', handler);
    return () => ipcRenderer.removeListener('term:exit', handler);
  },
  onRelink: (cb: (from: string, to: string) => void) => {
    const handler = (_e: unknown, m: { from: string; to: string }) => cb(m.from, m.to);
    ipcRenderer.on('session:relink', handler);
    return () => ipcRenderer.removeListener('session:relink', handler);
  },
  onIndex: (cb: (groups: SessionGroup[]) => void) => {
    const handler = (_e: unknown, groups: SessionGroup[]) => cb(groups);
    ipcRenderer.on('session:index', handler);
    return () => ipcRenderer.removeListener('session:index', handler);
  },
  // 背压回传（对齐 VS Code acknowledgeDataEvent）：渲染端每消费 N 字节即通知主进程，
  // 主进程据此对 PTY 做流控/消费进度记账。统一使用 terminal:ack 通道。
  acknowledgeDataEvent: (id: string, bytes: number) =>
    ipcRenderer.send('terminal:ack', { id, bytes }),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.send('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  getWindowBounds: (): Promise<{ x: number; y: number; width: number; height: number }> =>
    ipcRenderer.invoke('window:get-bounds'),
  setWindowBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send('window:set-bounds', bounds),
  onMaximizeChange: (cb: (maximized: boolean) => void) => {
    const handler = (_e: unknown, m: boolean) => cb(m);
    ipcRenderer.on('window:maximize-change', handler);
    return () => ipcRenderer.removeListener('window:maximize-change', handler);
  },
  getInitialConfig: (): AppConfig | null => initialConfig,
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
  setConfig: (partial: Partial<AppConfig>): Promise<void> => ipcRenderer.invoke('config:set', partial),
  // ── 文件管理器 / 预览（A + B）──
  fsListDir: (root: string, dir: string): Promise<any[]> => ipcRenderer.invoke('fs:listDir', { root, dir }),
  fsReadFile: (root: string, filePath: string, maxBytes?: number): Promise<any> =>
    ipcRenderer.invoke('fs:readFile', { root, path: filePath, maxBytes }),
  fsWriteFile: (root: string, filePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke('fs:writeFile', { root, path: filePath, content }),
  fsStat: (root: string, filePath: string): Promise<any> =>
    ipcRenderer.invoke('fs:stat', { root, path: filePath }),
  // ── 文件管理写操作（新建 / 重命名 / 删除 / 复制 / 移动）──
  fsMkdir: (root: string, dir: string): Promise<void> =>
    ipcRenderer.invoke('fs:mkdir', { root, dir }),
  fsCreateFile: (root: string, filePath: string, content?: string): Promise<void> =>
    ipcRenderer.invoke('fs:createFile', { root, path: filePath, content }),
  fsRename: (root: string, from: string, to: string): Promise<void> =>
    ipcRenderer.invoke('fs:rename', { root, from, to }),
  fsRemove: (root: string, filePath: string): Promise<void> =>
    ipcRenderer.invoke('fs:remove', { root, path: filePath }),
  fsCopy: (root: string, from: string, to: string): Promise<void> =>
    ipcRenderer.invoke('fs:copy', { root, from, to }),
  fsListNames: (root: string, dir: string): Promise<string[]> =>
    ipcRenderer.invoke('fs:listNames', { root, dir }),
  fsUniqueName: (base: string, existing: string[]): Promise<string> =>
    ipcRenderer.invoke('fs:uniqueName', { base, existing }),
  // 目录监听（外部变更自动刷新，对齐 VS Code FileWatcher）：
  // 渲染端订阅某目录，主进程经 'fs:change' 通道推送变更；返回取消订阅函数。
  fsWatch: (root: string, dir: string, cb: () => void): (() => void) => {
    const handler = (_e: unknown, m: { dir: string }) => {
      if (m.dir === dir) cb();
    };
    ipcRenderer.send('fs:watch', { root, dir });
    ipcRenderer.on('fs:change', handler);
    // 返回的取消函数：移除监听 + 通知主进程引用计数减一。
    return () => {
      ipcRenderer.removeListener('fs:change', handler);
      ipcRenderer.send('fs:unwatch', { root, dir });
    };
  },
  // ── Git 只读查看（D）──
  gitStatus: (cwd: string): Promise<any> => ipcRenderer.invoke('git:status', { cwd }),
  gitLog: (cwd: string, limit?: number): Promise<any[]> => ipcRenderer.invoke('git:log', { cwd, limit }),
  gitDiff: (cwd: string, ref?: string): Promise<string> => ipcRenderer.invoke('git:diff', { cwd, ref }),
  // 工作区实时监听：订阅某仓库 cwd，主进程经 'git:change' 推送变更；返回取消订阅函数。
  gitWatch: (cwd: string, cb: () => void): (() => void) => {
    const handler = (_e: unknown, m: { cwd: string }) => {
      if (m.cwd === cwd) cb();
    };
    ipcRenderer.send('git:watch', { cwd });
    ipcRenderer.on('git:change', handler);
    return () => {
      ipcRenderer.removeListener('git:change', handler);
      ipcRenderer.send('git:unwatch', { cwd });
    };
  },
  // 启动动画：renderer 首屏就绪后通知主进程显示窗口并淡出 splash（见 docs/adr/0003）。
  splashDone: () => ipcRenderer.send('splash:done'),
  // 受控外部链接通道：请求主进程用系统默认程序打开 URL（浏览器/mail 客户端）。
  // 协议白名单（http(s)/mailto）在主进程集中校验，file:// 不在此通道（本地文件走 fsOpenWithSystem）。
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('app:openExternal', url),
  // 用系统默认程序打开本地文件（二进制/无内置预览器的文件），等效双击文件。
  fsOpenWithSystem: (absPath: string): Promise<boolean> => ipcRenderer.invoke('fs:openWithSystem', absPath),
  // 在系统文件管理器中打开文件/目录所在位置并选中。
  fsShowInFolder: (absPath: string): Promise<boolean> => ipcRenderer.invoke('fs:showInFolder', absPath),
  // ── 集成终端（抽屉内嵌的真实 shell）──
  spawnTerminal: (req: { command?: string; cwd: string; profile?: any; sessionFile?: string; name?: string; key?: string }) =>
    ipcRenderer.invoke('terminal:spawn', req),
  listTerminalProfiles: (): Promise<TerminalProfile[]> => ipcRenderer.invoke('terminal:listProfiles'),
  createTerminal: (req: { profile: TerminalProfile; cwd: string }): Promise<IntegratedTerminalInfo> => ipcRenderer.invoke('terminal:create', req),
  createTerminalInAppWorkDir: (req: { profile: TerminalProfile }): Promise<IntegratedTerminalInfo> => ipcRenderer.invoke('terminal:createInAppWorkDir', req),
  listIntegratedTerminals: (): Promise<IntegratedTerminalInfo[]> => ipcRenderer.invoke('terminal:list'),
  destroyTerminal: (id: string): Promise<void> => ipcRenderer.invoke('terminal:destroy', id),
  terminalInput: (id: string, data: string) => ipcRenderer.send('terminal:input', { id, data }),
  terminalResize: (id: string, cols: number, rows: number) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
  onTerminalData: (cb: (id: string, data: string) => void) => {
    const handler = (_e: unknown, m: { id: string; data: string }) => cb(m.id, m.data);
    ipcRenderer.on('term:data', handler);
    return () => ipcRenderer.removeListener('term:data', handler);
  },
  onTerminalExit: (cb: (id: string) => void) => {
    const handler = (_e: unknown, m: { id: string }) => cb(m.id);
    ipcRenderer.on('term:exit', handler);
    return () => ipcRenderer.removeListener('term:exit', handler);
  },
  saveTerminalBuffer: (id: string, data: string) => ipcRenderer.send('terminal:saveBuffer', { id, data }),
  loadTerminalBuffer: (id: string): Promise<string | undefined> => ipcRenderer.invoke('terminal:loadBuffer', id),
  updateTerminalCwd: (id: string, cwd: string) => ipcRenderer.send('terminal:updateCwd', { id, cwd }),
  onTerminalList: (cb: (list: IntegratedTerminalInfo[]) => void) => {
    const handler = (_e: unknown, m: { list: IntegratedTerminalInfo[] }) => cb(m.list);
    ipcRenderer.on('term:list', handler);
    return () => ipcRenderer.removeListener('term:list', handler);
  },
});
