import type { OpenRequest, SessionGroup, SessionInfo, SessionStatus } from './types';

export interface PiApi {
  listSessions(): Promise<SessionGroup[]>;
  openSession(req: OpenRequest): Promise<SessionInfo>;
  terminate(key: string): Promise<void>;
  input(key: string, data: string): void;
  resize(key: string, cols: number, rows: number): void;
  debug(): Promise<{ count: number; pids: number[] }>;
  onData(cb: (key: string, data: string) => void): void;
  onStatus(cb: (key: string, status: SessionStatus) => void): void;
  onExit(cb: (key: string) => void): void;
}
export const pi = (window as any).pi as PiApi;
