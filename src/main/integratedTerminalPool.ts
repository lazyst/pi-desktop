import * as fs from 'node:fs';
import * as nodePty from 'node-pty';
import { randomUUID } from 'node:crypto';
import type { TerminalProfile, IntegratedTerminalInfo } from '../renderer/src/types';
import { getShellIntegrationInjection } from './shell-integration/inject';
import { BackpressureController } from './backpressure';

// 主进程端数据缓冲（5ms 时间窗聚合，等效 VS Code pty host 端 TerminalDataBufferer，
// 减少 IPC 消息量）。集成终端与 sessionPool 解耦（不写盘、不进会话索引）。
const DATA_BUFFER_MS = 5;
interface DataBuffer { chunks: string[]; timer: NodeJS.Timeout | null; }

// 集成终端进程池的可选配置。
export interface IntegratedTerminalPoolOptions {
  cols: number;
  rows: number;
  // 数据回调：key=终端实例 id，data=PTY 聚合后的输出。
  onData: (id: string, data: string) => void;
  onExit: (id: string) => void;
  // 实例列表变化（create/destroy/cwd 变更）时推送最新列表，供渲染端侧边栏实时刷新。
  onList: (list: IntegratedTerminalInfo[]) => void;
}

// 单个集成终端实例的内部条目。
interface Entry {
  pty: nodePty.IPty;
  info: IntegratedTerminalInfo;
  // 主进程→渲染端 IPC 投递的背压控制器（对齐 VS Code acknowledgeDataEvent 真流控）。
  bp: BackpressureController;
}

/**
 * 集成终端 PTY 池——独立运行的真实用户 shell 进程池，与 SessionPool（跑 pi 会话、
 * 写 .jsonl）完全解耦：不写盘、不进会话索引。用于渲染层内嵌的集成终端。
 *
 * 区别要点：
 *  - env 默认不声明 TERM_PROGRAM='vscode'（那是给 pi-tui 看的，对真实用户 shell 无意义）；
 *    例外：启用 shell integration 注入时，本池会额外给该实例的 env 补上
 *    TERM_PROGRAM='vscode' + VSCODE_INJECTION + VSCODE_NONCE——因为 VS Code 系注入脚本
 *    （fish 等）靠 TERM_PROGRAM 判定激活，注入路径与 pi-tui 路径互不干扰。
 *  - 背压计数在 pty.on('data') 实时处理、5ms 聚合仅做输出合并（对齐 VS Code 的先算背压再 fire 时序）。
 *  - 启动真实 shell 时注入 VS Code shell integration 脚本，使 shell 主动发 OSC 633 系序列，
 *    渲染端据此做命令级分段写入（见 XtermTerminal._segmentByShellIntegration）。
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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };

    // 计算 shell integration 注入（对齐 VS Code getShellIntegrationInjection）：
    // 改写 args 让 shell 加载注入脚本，混入 nonce/injection 等 env。
    // 不支持的 shell（如 cmd.exe）返回 undefined，走原始 args / 原始 env。
    const injection = getShellIntegrationInjection(profile.path, profile.args);
    let spawnArgs = profile.args;
    if (injection) {
      spawnArgs = injection.newArgs;
      Object.assign(env, injection.envMixin); // 含 TERM_PROGRAM='vscode' / VSCODE_INJECTION / VSCODE_NONCE
    }

    const pty = nodePty.spawn(profile.path, spawnArgs, {
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

    const entry: Entry = {
      pty,
      info,
      // 源头背压：超高水位 pause PTY、降到低水位 resume PTY（对齐 VS Code ptyProcess.pause/resume）。
      bp: new BackpressureController(() => pty.pause(), () => pty.resume()),
    };
    pty.on('data', (d: string) => {
      // 实时背压计数：PTY 数据一到立即累加，对齐 VS Code TerminalProcess.onProcessData
      // 的源头流控（先算背压再 fire 数据）。消除 5ms 聚合窗口导致的背压响应延迟。
      this.entries.get(id)?.bp.onData(d.length);
      this.emitData(id, d);
    });
    pty.on('exit', () => {
      this.clearDataBuffer(id);
      this.entries.get(id)?.bp.dispose();
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
    e.bp.dispose();
    this.entries.delete(id);
    this.opts.onList(this.list()); // create/destroy 都推最新列表
  }

  /** 退出时全清。 */
  killAll(): void {
    for (const id of [...this.entries.keys()]) this.destroy(id);
  }

  /** 实例是否仍存在（存活或尚未 destroy）。 */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /**
   * 列出当前所有存活的集成终端实例信息（含各自的 cwd）。
   * 渲染层据此按 cwd 聚合、统计各目录分组下运行中的终端数。
   */
  list(): IntegratedTerminalInfo[] {
    return [...this.entries.values()].map((e) => e.info);
  }

  /** 集成终端 cwd 变化（来自 shell integration 注入的 OSC 633;P;Cwd=）。
   * 更新该实例的缓存 cwd 并推送最新列表，使渲染端侧边栏目录分组实时刷新
   * （对齐 VS Code CwdDetectionCapability → 终端分组重排）。 */
  updateCwd(id: string, cwd: string): void {
    const e = this.entries.get(id);
    if (!e || !cwd) return;
    e.info.cwd = cwd;
    this.opts.onList(this.list());
  }

  /** 背压回传：渲染端每消费 N 字节即经 IPC 上报（见 index.ts terminal:ack），
   * 由本方法推进该实例的水位；水位降到阈值以下时 BackpressureController 自动补推积压数据。
   * 对齐 VS Code acknowledgeDataEvent 的真流控（而非仅记账）。 */
  acknowledgeDataEvent(id: string, bytes: number): void {
    this.entries.get(id)?.bp.acknowledge(bytes);
  }

  /** 聚合并下发单块 pty 数据（5ms 时间窗，等效 VS Code pty host 端 TerminalDataBufferer，
   * 用于减少 IPC 消息量）。
   * 背压计数已在 pty.on('data') 实时处理，此处仅做数据聚合后投递，
   * 不再重复累加 inflight（对齐 VS Code TerminalProcess.onProcessData
   * 的「先计算背压再 fire 数据」时序）。 */
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
      // 背压计数已在 pty.on('data') 实时处理，此处不再重复累加。
      // 数据照常发往渲染端（pause 只掐断 PTY 后续输出，已读出的这块照发）。
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
