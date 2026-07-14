import { contextBridge, ipcRenderer } from 'electron';
import type { OpenRequest, SessionGroup, SessionInfo, SessionStatus } from '../renderer/src/types';

contextBridge.exposeInMainWorld('pi', {
  listSessions: (): Promise<SessionGroup[]> => ipcRenderer.invoke('session:list'),
  openSession: (req: OpenRequest): Promise<SessionInfo> => ipcRenderer.invoke('session:open', req),
  terminate: (key: string): Promise<void> => ipcRenderer.invoke('session:terminate', key),
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
  onIndex: (cb: (groups: SessionGroup[]) => void) =>
    ipcRenderer.on('session:index', (_e, groups: SessionGroup[]) => cb(groups)),
});
