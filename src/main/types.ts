/**
 * 主进程共享类型定义。
 */

/**
 * 最小化 PTY 接口抽象，允许注入 node-pty 或 mock 实现。
 *
 * 选型：限定了 write/resize/kill/pause/resume/on 的最小方法集，不依赖 node-pty 类型。
 * 对齐 VS Code 的 IPty 接口语义（write/resize/kill + pause/resume 背压 + on('data'|'exit')）。
 */
export interface IPtyLike {
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  // 原生 pause/resume（node-pty IPty 接口），用于源头背压反压（对齐 VS Code ptyProcess.pause/resume）。
  pause(): void;
  resume(): void;
  on(event: 'data' | 'exit', cb: (d?: any) => void): void;
  pid?: number;
}