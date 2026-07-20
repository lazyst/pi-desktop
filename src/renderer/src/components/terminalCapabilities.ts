// 终端 capability —— 对齐 VS Code CommandDetectionCapability / CwdDetectionCapability
// 与 ShellIntegrationAddon 的 OSC 路由。
//
// VS Code 注入的 shell integration 脚本会发 OSC 633 系序列（见 src/main/shell-integration/
// 下脚本）。本项目不挂载 VS Code 那套完整的 ShellIntegrationAddon（它在 xterm parser 层注册
// OSC handler），而是复用本项目已有的「命令级分段」——XtermTerminal._segmentByShellIntegration
// 已经把 OSC 633 A/B/C/D/F/G 切成独立写入单元，本模块在此基础上做「语义解析」：
//   633;A            → 命令开始（prompt 完成，用户输入命令）
//   633;B            → 命令执行（输出开始）
//   633;D[;exit]     → 命令结束（可选退出码）
//   633;P;Cwd=xxx    → CWD 变化（可信，因注入脚本带有 nonce）
//   633;E;cmdline    → 显式命令文本（高置信）
//
// 与 VS Code 的差异（仅适配，不改语义）：
//  - VS Code 在 xterm parser 层用 registerOscHandler 接收 OSC；本项目在「分段写入」之后，
//    由 XtermTerminal 把每个 OSC 段交给本 capability 解析（数据同源，只是路由点不同）。
//  - VS Code 用 TerminalCapabilityStore 注册表 + PromptInputModel 推断命令行；本项目用
//    更轻的 ExtractCommandLine 策略（从 buffer marker 提取），不引入 PromptInputModel。

import type { IMarker } from '@xterm/xterm';

/** 对齐 VS Code TerminalCapability 枚举（仅本项目用到的子集）。 */
export const enum TerminalCapability {
  CommandDetection = 'commandDetection',
  CwdDetection = 'cwdDetection',
}

/** 单条已完成的命令（对齐 VS Code ITerminalCommand 的公开三段 + 元信息）。 */
export interface ITerminalCommand {
  /** 命令开始行 marker（B 序列）。 */
  marker?: IMarker;
  /** 命令开始时的列（B 序列的光标 X）。 */
  startX?: number;
  /** 输出开始行 marker（C 序列 / executed）。 */
  executedMarker?: IMarker;
  /** 命令结束行 marker（D 序列 / finished）。 */
  endMarker?: IMarker;
  /** 命令文本（来自 OSC 633;E 或 buffer 提取）。 */
  command?: string;
  /** 退出码（来自 OSC 633;D）。 */
  exitCode?: number;
  /** 命令执行时的 cwd。 */
  cwd?: string;
}

/** 命令检测 capability（对齐 VS Code ICommandDetectionCapability）。 */
export interface ICommandDetectionCapability {
  /** 已完成命令列表（按时间序）。 */
  readonly commands: readonly ITerminalCommand[];
  /** 当前正在进行的命令（进行中，未 finished）。 */
  readonly currentCommand: ITerminalCommand | undefined;
  /** 命令完成时触发（参数含完整命令）。 */
  onCommandFinished: (cb: (command: ITerminalCommand) => void) => void;
  /** 命令开始执行时触发（参数含命令文本，若已知）。 */
  onCommandExecuted: (cb: (command: ITerminalCommand) => void) => void;
  /** 喂一个 OSC 633 序列（已去掉首尾 ESC/ST），返回是否识别。 */
  handleSequence(seq: string): boolean;
  /** 由外部（如 buffer 提取）设置当前命令文本。 */
  setCommandLine(line: string): void;
}

/** CWD 检测 capability（对齐 VS Code ICwdDetectionCapability）。 */
export interface ICwdDetectionCapability {
  /** 当前可信 cwd（来自 OSC 633;P;Cwd=）。 */
  readonly cwd: string | undefined;
  /** cwd 变化时触发（参数含新 cwd）。 */
  onDidChangeCwd: (cb: (cwd: string) => void) => void;
  /** 喂一个 OSC 633;P 属性序列（已去掉首尾 ESC/ST），返回是否识别。 */
  handleProperty(seq: string): boolean;
}

/** 解析 OSC 633 序列内容（去掉 \x1b]633; 前缀、\x07 ST 后缀，返回命令字 + 参数）。
 * 例："A" → { cmd:'A', args:[] }；"D;0" → { cmd:'D', args:['0'] }；
 *      "P;Cwd=/foo" → { cmd:'P', args:['Cwd=/foo'] }。 */
function parseOsc633(body: string): { cmd: string; args: string[] } | null {
  // body 形如 "A" / "B" / "D;0" / "P;Cwd=/foo;nonce" / "E;ls%20-l"
  const sep = body.indexOf(';');
  const cmd = sep === -1 ? body : body.slice(0, sep);
  const rest = sep === -1 ? '' : body.slice(sep + 1);
  const args = rest.length ? rest.split(';') : [];
  return { cmd, args };
}

/** 反序列化 VS Code OSC 消息（%XX 转义 → 原文）。对齐 VS Code deserializeVSCodeOscMessage。 */
function deserializeVSCodeOscMessage(s: string): string {
  return s.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** 进行中的命令（对齐 VS Code PartialTerminalCommand 的核心三段 marker）。 */
interface PartialCommand {
  promptStartMarker?: IMarker;
  commandStartMarker?: IMarker;
  commandStartX?: number;
  executedMarker?: IMarker;
  finishedMarker?: IMarker;
  command?: string;
  cwd?: string;
}

export class CommandDetectionCapability implements ICommandDetectionCapability {
  readonly commands: ITerminalCommand[] = [];
  private _current: PartialCommand = {};
  private _finishedCbs: ((c: ITerminalCommand) => void)[] = [];
  private _executedCbs: ((c: ITerminalCommand) => void)[] = [];
  private readonly _getMarker: () => IMarker | undefined;

  /** @param getMarker 返回「当前 buffer 行」的 marker（xterm.registerMarker(0)）。 */
  constructor(getMarker: () => IMarker | undefined) {
    this._getMarker = getMarker;
  }

  get currentCommand(): ITerminalCommand | undefined {
    if (!this._current.commandStartMarker && this._current.executedMarker === undefined) return undefined;
    return this._toCommand(this._current);
  }

  onCommandFinished(cb: (c: ITerminalCommand) => void): void {
    this._finishedCbs.push(cb);
  }
  onCommandExecuted(cb: (c: ITerminalCommand) => void): void {
    this._executedCbs.push(cb);
  }

  /** 设置当前命令文本（来自 OSC 633;E 或外部推断）。 */
  setCommandLine(line: string): void {
    this._current.command = line;
  }

  handleSequence(seq: string): boolean {
    const parsed = parseOsc633(seq);
    if (!parsed) return false;
    switch (parsed.cmd) {
      case 'A': // 命令开始（prompt 完成）
        this._current.promptStartMarker = this._getMarker();
        return true;
      case 'B': // 命令执行（输出开始）
        this._current.commandStartMarker = this._getMarker();
        return true;
      case 'C': // 输出中（continuation，本项目不单独建模）
        return true;
      case 'E': { // 显式命令文本（高置信）
        const line = parsed.args[0] !== undefined ? deserializeVSCodeOscMessage(parsed.args[0]) : '';
        this._current.command = line;
        return true;
      }
      case 'D': { // 命令结束
        const exitCode = parsed.args[0] !== undefined ? parseInt(parsed.args[0], 10) : undefined;
        this._finish(exitCode);
        return true;
      }
      default:
        return false;
    }
  }

  private _finish(exitCode?: number): void {
    const finishedMarker = this._getMarker();
    this._current.finishedMarker = finishedMarker;
    const cmd = this._toCommand(this._current);
    cmd.exitCode = exitCode;
    // 提升到已完成列表（对齐 VS Code promoteToFullCommand）
    this.commands.push(cmd);
    const cb = this._finishedCbs.slice();
    this._current = {}; // 清空进行中状态，准备下一条
    for (const c of cb) c(cmd);
  }

  private _toCommand(p: PartialCommand): ITerminalCommand {
    return {
      marker: p.commandStartMarker,
      startX: p.commandStartX,
      executedMarker: p.executedMarker,
      endMarker: p.finishedMarker,
      command: p.command,
      cwd: p.cwd,
    };
  }
}

export class CwdDetectionCapability implements ICwdDetectionCapability {
  private _cwd: string | undefined;
  private _cwds = new Map<string, number>(); // cwd -> 访问顺序（保持最近访问）
  private _cbs: ((cwd: string) => void)[] = [];

  get cwd(): string | undefined {
    return this._cwd;
  }

  onDidChangeCwd(cb: (cwd: string) => void): void {
    this._cbs.push(cb);
  }

  handleProperty(seq: string): boolean {
    const parsed = parseOsc633(seq);
    if (!parsed || parsed.cmd !== 'P') return false;
    // args[0] = "Cwd=/abs/path"（可能带 nonce 在 args[1]，本项目不校验 nonce）
    const kv = parsed.args[0] ?? '';
    const eq = kv.indexOf('=');
    if (eq === -1) return false;
    const key = kv.slice(0, eq);
    const value = kv.slice(eq + 1);
    if (key !== 'Cwd') return false;
    const cwd = deserializeVSCodeOscMessage(value);
    this.updateCwd(cwd);
    return true;
  }

  private updateCwd(cwd: string): void {
    if (!cwd || cwd === this._cwd) {
      if (cwd) this._touch(cwd);
      return;
    }
    this._cwd = cwd;
    this._touch(cwd);
    const cb = this._cbs.slice();
    for (const c of cb) c(cwd);
  }

  private _touch(cwd: string): void {
    this._cwds.delete(cwd);
    this._cwds.set(cwd, Date.now());
  }
}

/** capability 注册表（对齐 VS Code TerminalCapabilityStore 的子集）。 */
export class TerminalCapabilityStore {
  private _store = new Map<TerminalCapability, unknown>();

  add(type: TerminalCapability, impl: unknown): void {
    this._store.set(type, impl);
  }
  get<T>(type: TerminalCapability): T | undefined {
    return this._store.get(type) as T | undefined;
  }
  has(type: TerminalCapability): boolean {
    return this._store.has(type);
  }
}
