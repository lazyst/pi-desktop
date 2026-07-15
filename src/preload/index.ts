import { contextBridge, ipcRenderer } from 'electron';
import type { OpenRequest, SessionGroup, SessionInfo, SessionStatus, AppConfig } from '../renderer/src/types';

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
  onData: (cb: (key: string, data: string) => void) =>
    ipcRenderer.on('session:data', (_e, m: { key: string; data: string }) => cb(m.key, m.data)),
  onStatus: (cb: (key: string, status: SessionStatus) => void) =>
    ipcRenderer.on('session:status', (_e, m: { key: string; status: SessionStatus }) => cb(m.key, m.status)),
  onExit: (cb: (key: string) => void) =>
    ipcRenderer.on('session:exit', (_e, m: { key: string }) => cb(m.key)),
  onRelink: (cb: (from: string, to: string) => void) =>
    ipcRenderer.on('session:relink', (_e, m: { from: string; to: string }) => cb(m.from, m.to)),
  onIndex: (cb: (groups: SessionGroup[]) => void) =>
    ipcRenderer.on('session:index', (_e, groups: SessionGroup[]) => cb(groups)),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.send('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  getWindowBounds: (): Promise<{ x: number; y: number; width: number; height: number }> =>
    ipcRenderer.invoke('window:get-bounds'),
  setWindowBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send('window:set-bounds', bounds),
  onMaximizeChange: (cb: (maximized: boolean) => void) =>
    ipcRenderer.on('window:maximize-change', (_e, m: boolean) => cb(m)),
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
  setConfig: (partial: Partial<AppConfig>): Promise<void> => ipcRenderer.invoke('config:set', partial),
});
