import { contextBridge, ipcRenderer } from 'electron';
import type { OpenRequest, SessionGroup, SessionInfo, SessionStatus, AppConfig } from '../renderer/src/types';

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
  openSession: (req: OpenRequest): Promise<SessionInfo> => ipcRenderer.invoke('session:open', req),
  terminate: (key: string): Promise<void> => ipcRenderer.invoke('session:terminate', key),
  deleteSession: (key: string): Promise<void> => ipcRenderer.invoke('session:delete', key),
  deleteMany: (keys: string[]): Promise<void> => ipcRenderer.invoke('session:deleteMany', keys),
  clearDirectory: (cwd: string): Promise<void> => ipcRenderer.invoke('session:clearDirectory', cwd),
  input: (key: string, data: string) => ipcRenderer.send('session:input', { key, data }),
  resize: (key: string, cols: number, rows: number) => ipcRenderer.send('session:resize', { key, cols, rows }),
  debug: (): Promise<{ count: number; pids: number[] }> => ipcRenderer.invoke('session:debug'),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('session:pickDirectory'),
  // 图片粘贴落盘：渲染端把剪贴板里的图片读成 base64 传来，主进程写临时文件并返回绝对路径。
  saveImage: (data: string, ext: string): Promise<string | null> =>
    ipcRenderer.invoke('session:saveImage', { data, ext }),
  onData: (cb: (key: string, data: string) => void) => {
    const handler = (_e: unknown, m: { key: string; data: string }) => cb(m.key, m.data);
    ipcRenderer.on('session:data', handler);
    return () => ipcRenderer.removeListener('session:data', handler);
  },
  onStatus: (cb: (key: string, status: SessionStatus) => void) => {
    const handler = (_e: unknown, m: { key: string; status: SessionStatus }) => cb(m.key, m.status);
    ipcRenderer.on('session:status', handler);
    return () => ipcRenderer.removeListener('session:status', handler);
  },
  onExit: (cb: (key: string) => void) => {
    const handler = (_e: unknown, m: { key: string }) => cb(m.key);
    ipcRenderer.on('session:exit', handler);
    return () => ipcRenderer.removeListener('session:exit', handler);
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
  // 主进程据此对 PTY 做流控/消费进度记账。
  acknowledgeDataEvent: (key: string, bytes: number) =>
    ipcRenderer.send('session:ack', { key, bytes }),
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
});
