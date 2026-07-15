import type { OpenRequest, SessionGroup, SessionInfo, SessionStatus } from './types';

export interface PiApi {
  listSessions(): Promise<SessionGroup[]>;
  openSession(req: OpenRequest): Promise<SessionInfo>;
  terminate(key: string): Promise<void>;
  deleteSession(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
  clearDirectory(cwd: string): Promise<void>;
  input(key: string, data: string): void;
  resize(key: string, cols: number, rows: number): void;
  debug(): Promise<{ count: number; pids: number[] }>;
  pickDirectory(): Promise<string | null>;
  onData(cb: (key: string, data: string) => void): void;
  onStatus(cb: (key: string, status: SessionStatus) => void): void;
  onExit(cb: (key: string) => void): void;
  onRelink(cb: (from: string, to: string) => void): void;
  onIndex(cb: (groups: SessionGroup[]) => void): void;
}

// Resolve `window.pi` lazily so the live IPC object injected by Electron at
// runtime (or by tests) is always used, instead of a snapshot captured at
// module-load time (when `window.pi` is still undefined).
export const pi: PiApi = new Proxy({} as PiApi, {
  get: (_target, prop) => (window as any).pi?.[prop],
});
