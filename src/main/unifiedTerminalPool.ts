/**
 * 统一终端 PTY 池——合并 SessionPool（spawn pi 进程）+ IntegratedTerminalPool（spawn shell 进程）
 * 的统一终端 PTY 池。
 *
 * 对外隐藏两种终端在 spawn 参数、环境变量、id 前缀等方面的差异，提供统一的
 * create/write/resize/destroy/killAll/updateCwd/acknowledgeDataEvent 接口。
 *
 * - command === 'pi'：spawn shell 进程，等待 shell 就绪后自动注入 pi 命令
 *   （走 Shell-Ready 模式，类似 Orca 的实现），
 *   id 形如 'live-<uuid>'，env 含 PI_DESKTOP=1。
 * - command === undefined：spawn 用户 shell 进程（走原 IntegratedTerminalPool.create 路径），
 *   id 形如 'term-<uuid>'，env 含 TERM=xterm-256color / COLORTERM=truecolor，
 *   并注入 VS Code shell integration 脚本。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as nodePty from 'node-pty';
import { randomUUID } from 'node:crypto';
import type { TerminalProfile } from '../renderer/src/types';
import { getShellIntegrationInjection } from './shell-integration/inject';
import { BackpressureController } from './backpressure';
import { readSessionName, decodeCwd, readGroupCwd } from './sessionUtils';
import { getDefaultShellProfile } from './shellProfiles';
import {
  createShellReadyScanState,
  scanForShellReady,
  injectPiCommand,
  getShellReadyLaunchConfig,
  SHELL_READY_TIMEOUT_MS,
  POST_READY_COMMAND_DELAY_MS,
  POST_READY_FALLBACK_MS,
} from './shell-ready/pi-shell-ready';

// 主进程端数据缓冲（5ms 时间窗聚合，等效 VS Code pty host 端 TerminalDataBufferer，
// 减少 IPC 消息量）。
const DATA_BUFFER_MS = 5;

/** 退出确认窗口（ms）。收到 pty 'exit' 后不立即关闭终端，而是启动此窗口，
 * 若窗口内仍有数据输出（shell 进程仍在运行），则重置窗口推迟关闭。
 * 对齐 VS Code 的 _queueProcessExit + onData 重置机制，用于抑制 Windows conpty
 * 在退出 alternate screen 时的误报 exit 事件——conpty 处理 \x1b[?1049l 时可能
 * 误关输出管道触发假的 pty exit，但 shell 进程仍存活且继续输出。
 *
 * 窗口值：500ms 平衡了「正常退出延迟感知」与「conpty 误报抑制可靠性」。 */
const PI_EXIT_DATA_WINDOW_MS = 500;

interface DataBuffer {
  chunks: string[];
  timer: NodeJS.Timeout | null;
}

/** 创建终端的选项。 */
export interface SpawnOptions {
  /** 'pi' → pi 会话，undefined → 默认 shell（使用 profile）。 */
  command?: string;
  /** 终端工作目录。不存在时回退 process.cwd()。 */
  cwd: string;
  /** Shell profile，command 为 undefined 时必填；command 为 'pi' 时可选（使用默认 shell）。 */
  profile?: TerminalProfile;
  /** 打开已有 .jsonl 会话文件（command==='pi' 时有效），传此值时 cwd 可从文件首行解析。 */
  sessionFile?: string;
  /** 新建会话的名称（command==='pi' 时有效）。 */
  name?: string;
  /** 显式指定会话 key（command==='pi' 时有效，存活检查用）。 */
  key?: string;
}

/** 单个终端实例的对外信息。 */
export interface TerminalInfo {
  id: string;
  /** 兼容旧 SessionInfo.key，与 id 相同。 */
  key: string;
  cwd: string;
  title: string;
  /** 兼容旧 SessionInfo.name，与 title 相同。 */
  name: string;
  type: 'pi' | 'shell';
  /** 兼容旧 SessionInfo.status，新建/打开的终端始终是 'running'。 */
  status: 'running' | 'dead';
}

/** UnifiedTerminalPool 的可选配置。 */
export interface UnifiedTerminalPoolOptions {
  cols: number;
  rows: number;
  /** pi 二进制路径，command==='pi' 时用于 spawn。默认 'pi'。 */
  piBin?: string;
  /** pi 会话的 sessions 目录（~/.pi/agent/sessions），用于关联新 .jsonl 文件。 */
  sessionsDir?: string;
  /** 数据回调：id=终端实例 id，data=PTY 聚合后的输出。 */
  onData: (id: string, data: string) => void;
  /** pi 会话状态变更（running / dead），供侧边栏绿点更新。 */
  onStatus: (id: string, status: 'running' | 'dead') => void;
  /** pi 会话退出回调。 */
  onExit: (id: string) => void;
  /** 实例列表变化（create/destroy/cwd 变更）时推送最新列表。 */
  onList: (list: TerminalInfo[]) => void;
  /** pi 会话晋升回调（live key → disk key 映射），供侧边栏高亮。 */
  onRelink?: (from: string, to: string) => void;
}

/** 内部存储的单个终端实例条目。 */
interface Entry {
  pty: nodePty.IPty;
  info: TerminalInfo;
  type: 'pi' | 'shell';
  /** 主进程→渲染端 IPC 投递的背压控制器（对齐 VS Code acknowledgeDataEvent 真流控）。 */
  bp: BackpressureController;
  /** pi 会话是否已与磁盘 .jsonl 关联。 */
  linked?: boolean;
  /** 关联的磁盘 .jsonl key（已晋升的 pi 会话）。 */
  diskKey?: string;
  /** 创建时该 cwd 下已有的磁盘 .jsonl key 集合，用于避免关联到旧文件。 */
  existingDiskKeys?: Set<string>;
  /** 用户主动终止（terminate）标记：置位后 pty 'exit' 跳过退出确认窗口直接关闭。 */
  terminating?: boolean;
}

/**
 * 统一终端 PTY 池——替代 SessionPool（spawn pi 进程）+ IntegratedTerminalPool（spawn shell 进程）。
 */
export class UnifiedTerminalPool {
  private opts: UnifiedTerminalPoolOptions;
  /** 实例 id → 条目（create 后保留，destroy/killAll 才移除）。 */
  private entries = new Map<string, Entry>();
  /** 每实例聚合缓冲（id 为终端实例 id）。 */
  private dataBuffers = new Map<string, DataBuffer>();

  constructor(opts: UnifiedTerminalPoolOptions) {
    this.opts = opts;
  }

  /** 磁盘 .jsonl 路径 → live key（已晋升的 pi 会话）。 */
  private alias = new Map<string, string>();

  /**
   * 根据 SpawnOptions 创建终端：
   * - command === 'pi' → spawn pi 进程（id 形如 'live-<uuid>'）
   * - command === undefined → spawn shell 进程（id 形如 'term-<uuid>'），需要 profile
   */
  create(opts: SpawnOptions): TerminalInfo {
    if (opts.command === 'pi') {
      // 检查 key 是否已有存活实例（避免重复创建进程）
      if (opts.key && this.entries.has(opts.key)) {
        return this.entries.get(opts.key)!.info;
      }
      // 检查 .jsonl 是否已关联到某个 live 进程
      if (opts.sessionFile && this.alias.has(opts.sessionFile)) {
        const liveKey = this.alias.get(opts.sessionFile)!;
        const existing = this.entries.get(liveKey);
        if (existing) return existing.info;
      }
      return this.spawnPi(opts);
    }
    // command === undefined → shell
    if (!opts.profile) {
      throw new Error('SpawnOptions.profile is required when command is undefined (shell)');
    }
    return this.spawnShell(opts.profile, opts.cwd);
  }

  /**
   * 解析 disk key → live key（用于 terminate 等）。
   * 若 key 自身在 entries 中则直接返回；否则查 alias 映射。
   */
  liveKeyFor(key: string): string {
    if (this.entries.has(key)) return key;
    const linked = this.alias.get(key);
    if (linked && this.entries.has(linked)) return linked;
    return key;
  }

  /**
   * 终止 pi 会话：杀掉 pty、清理别名映射、通知 onExit/onStatus。
   * 同时处理 disk key 反查 live key（侧边栏传入的是 .jsonl 路径）。
   */
  terminate(key: string): void {
    const liveKey = this.liveKeyFor(key);
    const e = this.entries.get(liveKey);
    if (!e || e.type !== 'pi') return;
    for (const [dk, lk] of this.alias) if (lk === liveKey) this.alias.delete(dk);
    // 标记主动终止：pty.on('exit') 将跳过退出确认窗口，直接关闭（避免延迟）。
    e.terminating = true;
    try { e.pty.kill(); } catch { /* 进程可能已退出 */ }
    this.clearDataBuffer(liveKey);
    e.bp.dispose();
    this.entries.delete(liveKey);
    if (e.diskKey) {
      this.clearDataBuffer(e.diskKey);
      this.opts.onStatus(e.diskKey, 'dead');
    }
    this.opts.onStatus(liveKey, 'dead');
    this.opts.onExit(liveKey);
  }

  /**
   * 关联已晋升的 disk session 到 live 进程。由外部（pushIndex）在文件变化时调用。
   * 从传入的 SessionGroup 中找到新创建的文件，匹配到对应 cwd 的 live 进程。
   */
  reconcile(groups: Array<{ cwd: string; sessions: Array<{ key: string; name: string; time: string }> }>): void {
    const disk: Array<{ key: string; cwd: string; mtime: number }> = [];
    for (const g of groups) {
      for (const s of g.sessions) {
        if (this.entries.has(s.key) || this.alias.has(s.key)) continue;
        let mtime = 0;
        try { mtime = fs.statSync(s.key).mtimeMs; } catch { /* ignore unreadable */ }
        disk.push({ key: s.key, cwd: g.cwd, mtime });
      }
    }
    disk.sort((a, b) => b.mtime - a.mtime);
    for (const [liveKey, e] of this.entries) {
      if (e.linked || e.type !== 'pi') continue;
      const cand = disk.find(
        (d) => d.cwd === e.info.cwd && !this.alias.has(d.key) && !e.existingDiskKeys?.has(d.key),
      );
      if (!cand) continue;
      e.linked = true;
      e.diskKey = cand.key;
      this.alias.set(cand.key, liveKey);
      this.opts.onStatus(cand.key, 'running');
      this.opts.onRelink?.(liveKey, cand.key);
    }
  }

  /** 返回某 cwd 在 sessionsDir 下已有的 .jsonl 路径集合（创建时用于排除旧文件）。 */
  existingDiskKeysForCwd(sessionsDir: string, cwd: string): Set<string> {
    const root = sessionsDir;
    if (!fs.existsSync(root)) return new Set();
    for (const enc of fs.readdirSync(root)) {
      const dir = path.join(root, enc);
      if (!fs.statSync(dir).isDirectory()) continue;
      const groupCwd = readGroupCwd(dir) ?? decodeCwd(enc);
      if (groupCwd !== cwd) continue;
      const keys = new Set<string>();
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) keys.add(path.join(dir, f));
      return keys;
    }
    return new Set();
  }

  /** spawn pi 进程（shell-ready 模式）：先 spawn shell，等待就绪后自动注入 pi 命令。
   * id 形如 'live-<uuid>'，env 含 PI_DESKTOP=1。
   *
   * 支持以下场景：
   * - 新建会话：`spawnPi({ cwd, name })` → 传 pi --name 参数
   * - 打开已有 .jsonl：`spawnPi({ sessionFile: '/path/to/session.jsonl' })` → 传 pi --session 参数
   * - 指定 key：`spawnPi({ key: 'live-xxx', cwd, name })` → 复用传入的 key
   *
   * Shell 就绪后自动注入 pi 命令；pi 退出后 shell 保留，用户可继续交互。
   * Pi 退出通过 OSC 133 D 序列检测，通知 UI 更新状态。 */
  private spawnPi(opts: SpawnOptions): TerminalInfo {
    const safeCwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : process.cwd();
    // 打开已有 .jsonl 时从文件首行解析 cwd，优先于传入的 cwd
    const resolvedCwd = opts.sessionFile
      ? (() => {
          try {
            const line = fs.readFileSync(opts.sessionFile!, 'utf8').split('\n', 1)[0];
            const obj = JSON.parse(line);
            return typeof obj?.cwd === 'string' && fs.existsSync(obj.cwd) ? obj.cwd : safeCwd;
          } catch { return safeCwd; }
        })()
      : safeCwd;
    const id = opts.key ?? `live-${randomUUID()}`;

    // 环境变量：不设 TERM_PROGRAM=vscode 以免触发用户的 VS Code shell integration（
    // 它会在每次 prompt 发射 OSC 133 D 序列，对终端输出造成干扰）。
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_DESKTOP: '1',
    };

    // ── 获取默认 shell profile ──
    const profile = opts.profile ?? getDefaultShellProfile();

    // ── 构建 pi 命令参数 ──
    const piBin = this.opts.piBin ?? 'pi';
    const piArgs: string[] = [];
    if (opts.sessionFile) {
      piArgs.push('--session', opts.sessionFile);
    } else if (opts.name) {
      piArgs.push('--name', opts.name);
    }
    const piCommand = piArgs.length > 0 ? `${piBin} ${piArgs.join(' ')}` : piBin;

    // ── 获取 shell-ready launch config ──
    const readyConfig = getShellReadyLaunchConfig(profile);
    const spawnArgs = readyConfig.shellArgs;
    Object.assign(env, readyConfig.envMixin);

    // ── spawn shell（不是 pi） ──
    const pty = nodePty.spawn(profile.path, spawnArgs, {
      cwd: resolvedCwd,
      cols: this.opts.cols,
      rows: this.opts.rows,
      env,
      // Windows 关键：shell:true 避开 conpty 附着竞态导致的原生崩溃
      shell: process.platform === 'win32',
    });

    // 打开已有 .jsonl 时尝试从文件读取会话名作为标题
    let title = 'pi';
    if (opts.sessionFile) {
      try {
        const name = readSessionName(opts.sessionFile);
        if (name) title = name;
      } catch { /* 忽略 */ }
    } else if (opts.name) {
      title = opts.name;
    }

    const info: TerminalInfo = {
      id,
      key: id,
      cwd: resolvedCwd,
      title,
      name: title,
      type: 'pi',
      status: 'running',
    };

    // 收集该 cwd 下已有的 .jsonl keys，用于 reconcile 时排除（避免关联到旧文件）。
    const existingKeys = this.existingDiskKeysForCwd(this.opts.sessionsDir ?? '', resolvedCwd);

    // ── shell-ready 状态 ──
    let commandInjected = false;
    let shellReadyTimer: NodeJS.Timeout | null = null;
    let postReadyTimer: NodeJS.Timeout | null = null;
    const scanState = createShellReadyScanState();

    // ── 退出确认窗口状态 ──
    // 收到 pty 'exit' 后启动延迟窗口；窗口内若仍有数据输出（shell 仍存活），重置窗口推迟关闭。
    // 对齐 VS Code 的 _queueProcessExit + onData 重置机制，用于抑制 conpty 误报 exit。
    let pendingExitTimer: NodeJS.Timeout | null = null;

    const clearPendingExit = () => {
      if (pendingExitTimer) { clearTimeout(pendingExitTimer); pendingExitTimer = null; }
    };

    /** 真正关闭终端条目。由 pendingExitTimer 到期或用户主动调用 terminate 触发。 */
    const closeEntry = () => {
      pendingExitTimer = null;
      const e = this.entries.get(id);
      // 已被 terminate() 等路径关闭过（entry 已删除），跳过，避免重复 onExit。
      if (!e) return;
      clearTimers();
      this.clearDataBuffer(id);
      e.bp.dispose();
      this.entries.delete(id);
      this.opts.onStatus(id, 'dead');
      if (e.diskKey) this.opts.onStatus(e.diskKey, 'dead');
      this.opts.onExit(id);
    };

    // 清理定时器
    const clearTimers = () => {
      if (shellReadyTimer) { clearTimeout(shellReadyTimer); shellReadyTimer = null; }
      if (postReadyTimer) { clearTimeout(postReadyTimer); postReadyTimer = null; }
    };

    // 注入 pi 命令
    const doInject = () => {
      if (commandInjected) return;
      commandInjected = true;
      clearTimers();
      injectPiCommand(pty, piCommand, readyConfig.bracketedPasteSafe);
    };

    const entry: Entry = {
      pty,
      info,
      type: 'pi',
      bp: new BackpressureController(() => pty.pause(), () => pty.resume()),
      linked: !!opts.sessionFile,
      diskKey: opts.sessionFile,
      existingDiskKeys: existingKeys.size > 0 ? existingKeys : undefined,
    };

    pty.on('data', (d: string) => {
      // 实时背压计数
      this.entries.get(id)?.bp.onData(d.length);

      // 退出确认窗口：若存在待处理的退出（conpty 可能误报 exit，shell 仍存活），
      // 只要还有数据输出就重置窗口，推迟真正关闭。对齐 VS Code TerminalProcess
      // 的 onData 里 `if (this._closeTimeout) this._queueProcessExit()` 机制。
      if (pendingExitTimer) {
        clearPendingExit();
        pendingExitTimer = setTimeout(closeEntry, PI_EXIT_DATA_WINDOW_MS);
      }

      if (!commandInjected) {
        // ── 扫描 shell-ready 标记 ──
        const result = scanForShellReady(scanState, d);
        if (result.matched) {
          // 标记已收到，shell 就绪
          if (result.postMarkerBytesObserved) {
            // 标记后已有数据 → 短延迟后注入（等行编辑器进入 raw 模式）
            postReadyTimer = setTimeout(doInject, POST_READY_COMMAND_DELAY_MS);
          } else {
            // 标记后无数据 → 等下一个 data 事件
            const onNextData = () => {
              pty.removeListener('data', onNextData);
              postReadyTimer = setTimeout(doInject, POST_READY_COMMAND_DELAY_MS);
            };
            pty.on('data', onNextData);
            // 超时兜底
            postReadyTimer = setTimeout(() => {
              pty.removeListener('data', onNextData);
              doInject();
            }, POST_READY_FALLBACK_MS);
          }
          // 剥离标记后的数据发给渲染端
          if (result.output) this.emitData(id, result.output);
        } else if (result.output) {
          this.emitData(id, result.output);
        }
      } else {
        // 转发数据到渲染端。
        //
        // 注意：这里刻意不再检测 pi 退出（移除了原来的 detectPiExit / OSC 133 D
        // 检测）。原实现依赖 shell prompt 的 OSC 133 D 序列来判断「pi 是否退出」，
        // 但该序列是 shell 的间接信号，会在多种场景下出现——pi 真正退出时 shell
        // 恢复 prompt、pi-tui 切换 TUI 模式（fullscreen↔regular）时 conpty 重发
        // 主缓冲区内容、消息或工具输出中嵌入的 OSC 终码序列等——极易被误判，
        // 典型表现就是「从 fullscreen 切到 regular 时终端被误关」。
        //
        // 改为让终端 tab 的生命周期跟随 shell 进程：pi 退出后 shell 继续运行、
        // prompt 恢复，tab 保持打开；仅当 shell 进程真正退出或用户主动终止时
        // 才关闭 tab。这与普通集成终端的语义一致。
        this.emitData(id, d);
      }
    });

    pty.on('exit', () => {
      // 用户主动终止时（terminate()），直接关闭（跳过数据窗口，避免延迟）。
      const e = this.entries.get(id);
      if (e?.terminating) return;

      // 数据窗口：不立即关闭，启动短窗口让进程最后输出数据。
      // 若窗口内仍有数据（onData 重置定时器），说明 shell 进程仍存活，继续推迟。
      // 持续无数据 → 窗口到期 → 真正关闭。
      //
      // 背景：Windows conpty 在 pi-tui 退出 alt screen（写 \x1b[?1049l）时可能
      // 误关输出管道，触发假的 pty exit 事件，但 shell 进程其实仍存活。此窗口机制
      // 对齐 VS Code TerminalProcess._queueProcessExit + onData 重置，不依赖检测
      // 特定控制序列（\x1b[?1049l 可能被分块或不被 conpty 转发），更加稳健。
      if (pendingExitTimer) return;
      pendingExitTimer = setTimeout(closeEntry, PI_EXIT_DATA_WINDOW_MS);
    });

    // ── shell-ready 超时兜底 ──
    shellReadyTimer = setTimeout(() => {
      if (!commandInjected) {
        console.warn('[pi-shell-ready] shell-ready timeout, injecting pi command anyway');
        doInject();
      }
    }, SHELL_READY_TIMEOUT_MS);

    this.entries.set(id, entry);
    // 打开已有 .jsonl 时立即建立 alias 映射
    if (opts.sessionFile) {
      this.alias.set(opts.sessionFile, id);
      this.opts.onStatus(opts.sessionFile, 'running');
      this.opts.onRelink?.(id, opts.sessionFile);
    }
    this.opts.onStatus(id, 'running');
    return info;
  }

  /** spawn shell 进程：id 形如 'term-<uuid>'，env 含 TERM=xterm-256color / COLORTERM=truecolor，
   * 并注入 VS Code shell integration 脚本。 */
  private spawnShell(profile: TerminalProfile, cwd: string): TerminalInfo {
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
      // Windows 关键：与 SessionPool 的 ptyFactory + pi 分支对齐，显式 shell:true。
      // 否则 node-pty 的 conpty 后端在 pty 被 kill() 销毁时会调用 conpty_console_list_agent
      // 的 getConsoleProcessList → AttachConsole failed → 抛 0xC0000005 原生崩溃，
      // 直接拖垮整个 Electron 主进程（表现为"新建终端一闪即逝 / 应用闪退"）。
      // shell:true 让 node-pty 走 cmd.exe 包裹路径，避开该 conpty 附着竞态。
      shell: true,
    });

    const info: TerminalInfo = {
      id,
      key: id,
      cwd: safeCwd,
      // 首版用 profile.label 作为标题（如 'PowerShell'），后续可改为 cwd 末段。
      title: profile.label,
      name: profile.label,
      type: 'shell',
      status: 'running',
    };

    const entry: Entry = {
      pty,
      info,
      type: 'shell',
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

  /** 杀掉并清理指定终端。清理缓冲，回调 onList 推送最新列表。 */
  destroy(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    // 标记 pi 类型主动终止，使 on('exit') 跳过数据窗口、立即关闭（避免延迟）。
    if (e.type === 'pi') e.terminating = true;
    try { e.pty.kill(); } catch { /* 进程可能已退出 */ }
    this.clearDataBuffer(id);
    e.bp.dispose();
    this.entries.delete(id);
    if (e.type === 'pi') this.opts.onExit(id);
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

  /** 返回所有存活终端信息。 */
  list(): TerminalInfo[] {
    return [...this.entries.values()].map((e) => e.info);
  }

  /** 更新终端 cwd。仅 shell 类型有效（pi 会话的 cwd 由 pi 进程自身管理）。 */
  updateCwd(id: string, cwd: string): void {
    const e = this.entries.get(id);
    if (!e || e.type !== 'shell' || !cwd) return;
    e.info.cwd = cwd;
    this.opts.onList(this.list());
  }

  /** 背压回传：渲染端每消费 N 字节即经 IPC 上报，推进该实例的水位；
   * 水位降到阈值以下时 BackpressureController 自动恢复 PTY 输出。
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

  /** 解除 live key 关联的磁盘 session alias。
   * 用于 /new 命令后，使旧 session 的磁盘条目能 spawn 新进程而非复用已有 PTY。
   * 同时重置 entry 的 linked/diskKey 状态，使 reconcile 能重新关联新 .jsonl。 */
  unlinkDiskSession(liveKey: string): void {
    for (const [dk, lk] of this.alias) {
      if (lk === liveKey) {
        this.alias.delete(dk);
        break;
      }
    }
    const e = this.entries.get(liveKey);
    if (e) {
      e.linked = false;
      e.diskKey = undefined;
    }
  }
}
