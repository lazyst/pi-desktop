import * as fs from 'node:fs';
import * as nodePty from 'node-pty';
import { randomUUID } from 'node:crypto';
import type { TerminalProfile, IntegratedTerminalInfo } from '../renderer/src/types';

// 主进程端数据缓冲（对齐 VS Code ptyService 的 TerminalDataBufferer / SessionPool）：
// 每实例 5ms 时间窗聚合 pty 小块输出，窗口结束一次性回调 onData，避免高频小块直达
// 渲染端造成的中间帧闪烁。集成终端与 sessionPool 解耦（不写盘、不进会话索引）。
const DATA_BUFFER_MS = 5;
interface DataBuffer { chunks: string[]; timer: NodeJS.Timeout | null; }

// 集成终端进程池的可选配置。
export interface IntegratedTerminalPoolOptions {
  cols: number;
  rows: number;
  // 数据回调：key=终端实例 id，data=PTY 聚合后的输出。
  onData: (id: string, data: string) => void;
  onExit: (id: string) => void;
}

// 单个集成终端实例的内部条目。
interface Entry {
  pty: nodePty.IPty;
  info: IntegratedTerminalInfo;
}

/**
 * 集成终端 PTY 池——独立运行的真实用户 shell 进程池，与 SessionPool（跑 pi 会话、
 * 写 .jsonl）完全解耦：不写盘、不进会话索引。用于渲染层内嵌的集成终端抽屉。
 *
 * 区别要点：
 *  - env 不声明 TERM_PROGRAM='vscode'（那是给 pi-tui 看的，对真实 shell 无意义）。
 *  - 输出走 5ms 聚合窗口后回调 onData，节奏对齐 SessionPool 的双段缓冲设计。
 */
export class IntegratedTerminalPool {
  private opts: IntegratedTerminalPoolOptions;
  // 实例 id → 条目（create 后保留，destroy/killAll 才移除）。
  private entries = new Map<string, Entry>();
  // 每实例聚合缓冲（id 为终端实例 id）。
  private dataBuffers = new Map<string, DataBuffer>();

  constructor(opts: IntegratedTerminalPoolOptions) {
    this.opts = opts;
  }

  /**
   * 用指定 profile 在 cwd 创建终端，返回实例信息。
   * id 形如 'term-<uuid>'。cwd 不存在时回退 process.cwd()。
   */
  create(profile: TerminalProfile, cwd: string): IntegratedTerminalInfo {
    const safeCwd = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
    const id = `term-${randomUUID()}`;

    // 像 VS Code / 其他终端模拟器一样，向 pty 显式声明终端类型与真彩色支持。
    // 注意：不声明 TERM_PROGRAM='vscode'——那是给 pi-tui 看的特殊标记，
    // 对真实用户 shell 无意义。若 process.env 已携带 TERM_PROGRAM 则保留原值。
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };

    const pty = nodePty.spawn(profile.path, profile.args, {
      cwd: safeCwd,
      cols: this.opts.cols,
      rows: this.opts.rows,
      env,
      // Windows 关键：与 SessionPool 的 ptyFactory 对齐，显式 shell:true。
      // 否则 node-pty 的 conpty 后端在 pty 被 kill() 销毁时会调用 conpty_console_list_agent
      // 的 getConsoleProcessList → AttachConsole failed → 抛 0xC0000005 原生崩溃，
      // 直接拖垮整个 Electron 主进程（表现为“新建终端一闪即逝 / 应用闪退”）。
      // shell:true 让 node-pty 走 cmd.exe 包裹路径，避开该 conpty 附着竞态。
      shell: true,
    });

    const info: IntegratedTerminalInfo = {
      id,
      profileId: profile.id,
      cwd: safeCwd,
      // 首版用 profile.label 作为标题（如 'PowerShell'），后续可改为 cwd 末段。
      title: profile.label,
    };

    const entry: Entry = { pty, info };
    pty.on('data', (d: string) => this.emitData(id, d));
    pty.on('exit', () => {
      this.clearDataBuffer(id);
      this.entries.delete(id);
      this.opts.onExit(id);
    });

    this.entries.set(id, entry);
    return info;
  }

  /** 键盘输入 → pty.write。 */
  write(id: string, data: string): void {
    this.entries.get(id)?.pty.write(data);
  }

  /** 调整终端尺寸。pty 已退出时安全跳过（resize 会抛错）。 */
  resize(id: string, cols: number, rows: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    try { e.pty.resize(cols, rows); } catch { /* pty 已退出，吸收竞态 */ }
  }

  /** 杀掉并清理指定终端。 */
  destroy(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    try { e.pty.kill(); } catch { /* 进程可能已退出 */ }
    this.clearDataBuffer(id);
    this.entries.delete(id);
  }

  /** 退出时全清。 */
  killAll(): void {
    for (const id of [...this.entries.keys()]) this.destroy(id);
  }

  /** 实例是否仍存在（存活或尚未 destroy）。 */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** 聚合并下发单块 pty 数据（5ms 时间窗，对齐 TerminalDataBufferer）。 */
  private emitData(id: string, data: string): void {
    let buf = this.dataBuffers.get(id);
    if (!buf) {
      buf = { chunks: [], timer: null };
      this.dataBuffers.set(id, buf);
    }
    buf.chunks.push(data);
    if (buf.timer) return; // 窗口已开，等待 flush
    buf.timer = setTimeout(() => {
      const b = this.dataBuffers.get(id);
      if (!b) return;
      const joined = b.chunks.join('');
      b.chunks = [];
      b.timer = null;
      this.dataBuffers.delete(id);
      this.opts.onData(id, joined);
    }, DATA_BUFFER_MS);
  }

  /** 清理某实例的待发聚合缓冲，避免 destroy 后迟到数据回调已销毁的渲染实例。 */
  private clearDataBuffer(id: string): void {
    const b = this.dataBuffers.get(id);
    if (b?.timer) clearTimeout(b.timer);
    this.dataBuffers.delete(id);
  }
}
