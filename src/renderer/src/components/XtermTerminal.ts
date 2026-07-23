// XtermTerminal —— 完全对齐 VS Code 集成终端的 xterm 装配（见 vscode-src
// src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts 与 terminalInstance.ts）。
//
// 本次重写回归 VS Code 的标准做法，移除此前堆砌的自创 hack（5ms+行切片+rAF 逐批写、亚像素
// 阈值、流式活跃期冻结列宽、写后逐批锁底、scrollOnEraseInDisplay:false）。对齐 VS Code 后由
// xterm 原生处理同步输出与贴底，复杂场景的防抖交给 VS Code 同款的分轴 resize 与 5ms 时间窗
// 聚合，而非自研多套相互打架的计时器。
//
// 与 VS Code 集成终端对齐的装配点：
//   - 渲染器：open 之后装载 WebGL（对齐 VS Code XtermTerminal.attachToElement 的「TODO: Move
//     before open」之前的原生顺序），但会话内恒定锁定、绝不中途切换（rendererLocked）。上下文
//     丢失后整会话降级 DOM，不重建 WebGL（对齐 VS Code _webglAddon.onContextLoss 的精神）。
//   - 数据缓冲：用 VS Code 同款 TerminalDataBufferer（独立文件 terminalDataBufferer.ts），5ms
//     固定时间窗聚合到达的 onData 块，窗口结束一次性 term.write（对齐 VS Code TerminalInstance
//     收 onProcessData → TerminalDataBufferer → _writeProcessData）。
//   - 命令级分段：对齐 VS Code TerminalInstance._onProcessData，按 OSC 633（C/D）序列把数据切成
//     语义段，各段按序 term.write，使命令边界成为独立写入单元、且可被装饰层差分解析。
//   - 写后背压：term.write 回调里调 pi.acknowledgeDataEvent(key, len)（对齐 VS Code
//     _writeProcessData 的 acknowledgeDataEvent 流控）。
//   - 写完成闸门：_latestWriteSeq === _latestParsedSeq 轮询（对齐 VS Code _flushXtermData）。
//   - resize：用 VS Code 同款 TerminalResizeDebouncer（独立文件 terminalResizeDebouncer.ts），
//     Y（行数）即时、X（列宽）100ms 防抖、不可见推迟到 idle、小 buffer/立即标志走同步
//     （对齐 VS Code TerminalResizeDebouncer + TerminalInstance.setVisible 的 flush+resize）。
//   - 构造选项：逐项对齐 VS Code 默认（cursorBlink/cursorStyle/cursorInactiveStyle/
//     minimumContrastRatio/drawBoldTextInBrightColors/tabStopWidth/letterSpacing/fontWeight 等）。
//     其中 scrollOnEraseInDisplay 恢复为 VS Code 默认 true（此前为消除全屏 TUI 抖动的 hack 设为
//     false；回归标准后由 xterm 原生与分轴 resize 处理，不再需要反向设置）。
//   - 装饰/导航：加载 DecorationAddon（差分 overlay 基座，对齐 VS Code DecorationAddon）与
//     MarkNavigationAddon（mark 导航，对齐 VS Code MarkNavigationAddon）。
//   - 剪贴板：@xterm/addon-clipboard 接管复制/粘贴（对齐 VS Code ClipboardAddon 装配）。
//   - Unicode：Unicode11Addon 稳定 CJK/宽字符度量（对齐 VS Code _updateUnicodeVersion）。
//
// 对外契约（B2-a 契约保形）：本类只通过构造传入的 pi 接口收发数据，不触碰主进程 / preload / IPC
// 信道名。PTY 链路零接触（见 docs/adr/0002）。
import { Terminal, type IMarker, type IDecoration, type IDecorationOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { getTheme, TERM_THEMES, getTermTheme, type Theme } from '../theme';
import { getFontSize } from '../fontSize';
import { registerTerminal, unregisterTerminal, type LiveTerminal } from '../lib/terminal-registry';
import { TerminalDataBufferer } from './terminalDataBufferer';
import { TerminalResizeDebouncer } from './terminalResizeDebouncer';
import { DecorationAddon } from './decorationAddon';
import { MarkNavigationAddon } from './markNavigationAddon';
import { SessionChannel } from './terminalChannel';
import type { TerminalChannel } from './terminalChannel';
import type { PiApi } from '../ipc';
import { defaultConfig, SCROLLBACK_MIN, SCROLLBACK_MAX } from '../../../main/config';
import { FlowControlConstants } from '../../../main/backpressure';
import {
  TerminalCapability,
  TerminalCapabilityStore,
  CommandDetectionCapability,
  CwdDetectionCapability,
} from './terminalCapabilities';
import { detectLinksInLine, buildLink } from './terminalLinks';
import { PI_FILE_DRAG_MIME } from './FileTree';
import '@xterm/xterm/css/xterm.css';

// 终端字体栈：对齐 VS Code 默认（等宽优先）。鉴于已加载 Unicode11Addon 处理宽字符度量，
// 不再需要此前「含 CJK 的等宽字体栈」hack——VS Code 同样不靠字体栈兜底 CJK 度量，而是交给
// Unicode11Addon + xterm 原生渲染。移除主栈里的 'Microsoft YaHei Mono'/'Microsoft YaHei' 等
// 可变宽 CJK 字体：它们会让 WebGL 渲染器在 CJK 占比变化的帧间出现 cell 度量跳变（全屏 TUI
// 差分重绘时表现为整屏上下抖动）。CJK 兜底交由 xterm 的 generic monospace fallback +
// Unicode11Addon 处理，纯 DOM 渲染器路径仍由 CSS 兜底覆盖。
const FONT_MONO =
  "'JetBrains Mono','Fira Code','Cascadia Code',ui-monospace,monospace";

// 对齐 VS Code TerminalDataBufferer 的固定时间窗（5ms）：窗口内累积到达的数据块，
// 窗口结束一次性 term.write，消除流式高频重绘的中间帧闪烁。
const WRITE_DEBOUNCE_MS = 5;

/** 从主进程注入的初始配置读取 scrollback 值，进程内恒定（不热更新）。
 * 新建终端时构造 xterm 选项用此值，已存在的终端不受滚动设置变更影响。
 * 回退默认 5000，夹在 [SCROLLBACK_MIN, SCROLLBACK_MAX] 区间。 */
function getScrollback(): number {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    if (cfg && typeof cfg.scrollback === 'number') {
      return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.round(cfg.scrollback)));
    }
  } catch {
    /* 无注入配置（如测试）时回退默认 */
  }
  return defaultConfig().scrollback;
}

export interface XtermTerminalOptions {
  // 数据通道抽象：PTY 输出订阅 / 退出订阅 / 键盘输入 / 尺寸通知全部走 channel，
  // XtermTerminal 不再直接引用全局 pi 的会话数据流 API（见 terminalChannel.ts）。
  // 可选：省略时回退为 SessionChannel(pi, sessionKey)（兼容既有测试 / 旧调用方）。
  channel?: TerminalChannel;
  // 仅用于日志/调试标识与数据缓冲 id（保留原 sessionKey 语义，与 channel 对应同一进程）。
  sessionKey: string;
  // 当 channel 未显式提供时，用于构建默认 SessionChannel；也被保留用于非数据流功能
  // （saveImage / getPathForFile / acknowledgeDataEvent）。与重构前一致。
  pi: PiApi;
}

/**
 * 单个会话的 xterm 终端封装。生命周期：
 *   new → mount(host)（首次进入 active 时构造 open + 装载 addons + 锁定渲染器 + 绑 IPC）
 *   → setActive(bool)（切 tab 时 keep-alive，不重建）→ unmount()（真正销毁，如会话被删除）。
 * 对 React 壳完全透明：壳在首次 active 时调用 mount、非 active 时调用 setActive(false)、
 * 再次 active 时调用 setActive(true)，会话删除时调用 unmount()，并把 host div / 置底按钮的
 * DOM 事件转交本类。
 */
export class XtermTerminal implements LiveTerminal {
  private readonly sessionKey: string;
  private readonly channel: TerminalChannel;
  // 保留 pi 引用仅用于「非会话数据流」功能：剪贴板图片落盘(saveImage)、拖拽文件路径解析
  // (getPathForFile)、写后背压回传(acknowledgeDataEvent)。所有 PTY 输入/输出/退出/resize
  // 数据通信均改走 this.channel（见 terminalChannel.ts）。
  private readonly pi: PiApi;
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private opened = false;
  private mounted = false; // 是否已完成首次 mount（keep-alive 下不再重建）
  private active = false; // keep-alive：当前是否可见（对齐 VS Code setVisible）
  private rendererLocked = false; // 本实例是否已锁定渲染器（open 后不再中途切换）
  private disposed = false;
  private host: HTMLElement | null = null;
  // 当前装载的 WebGL addon 实例引用（open 后锁定、会话内恒定；上下文丢失时置回退）。
  private webgl: WebglAddon | null = null;
  // WebGL 上下文是否丢失（丢失后整会话降级 DOM，待下次可见/resize 触发重建尝试）。
  private webglContextLost = false;

  // —— 数据写缓冲（对齐 VS Code TerminalDataBufferer 的 5ms 时间窗聚合）——
  private dataBufferer: TerminalDataBufferer | null = null;
  private stopBuffering: (() => void) | null = null;

  // —— resize 分轴防抖（对齐 VS Code TerminalResizeDebouncer）——
  private resizeDebouncer: TerminalResizeDebouncer | null = null;

  // —— 装饰 / 导航（对齐 VS Code DecorationAddon / MarkNavigationAddon）——
  private decorationAddon: DecorationAddon | null = null;
  private markNavigationAddon: MarkNavigationAddon | null = null;

  // —— shell integration capability（对齐 VS Code CommandDetectionCapability / CwdDetectionCapability）——
  // 消费注入脚本发的 OSC 633 序列：命令生命周期 + 可信 cwd 检测。
  private caps: TerminalCapabilityStore | null = null;
  private searchAddon: SearchAddon | null = null;
  private serializeAddon: SerializeAddon | null = null;
  // 终端内链接 provider 的反注册函数（对齐 VS Code registerLinkProvider 的 IDisposable）。
  private linkProviderDisposable: { dispose: () => void } | null = null;
  // cwd 变化回调：集成终端把检测到的可信 cwd 回传主进程，驱动侧边栏目录分组实时刷新。
  onCwdChange: ((cwd: string) => void) | null = null;
  // 文件链接点击回调：把命中文件（含行号）回传壳，由文件树/编辑器定位选中（额外于系统打开）。
  onOpenFile: ((path: string, line?: number, col?: number) => void) | null = null;
  // 命令完成回调（供未来「重跑 / 复制命令」等能力使用）。
  onCommandFinished: ((command: string) => void) | null = null;

  // —— 写前/写后通知（对齐 VS Code TerminalInstance._onWillData / _onData）——
  // 外部消费者可在 onWillData 中保存滚动状态、在 onData 中恢复。
  onWillData: ((data: string) => void) | null = null;
  onData: ((data: string) => void) | null = null;

  // —— 写完成确认（对齐 VS Code _flushXtermData 的「已写入=已解析」闸门）——
  private _latestWriteSeq = 0;
  private _latestParsedSeq = 0;
  // 背压累积缓冲（对齐 VS Code AckDataBufferer）：未达 FlowControlConstants.CharCountAckSize 的 ack
  // 暂存在这里，累积触发后再一次发送，减少 IPC 频次。
  private _unsentAckChars = 0;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;

  // —— 反注册函数 ——
  private offExit: (() => void) | null = null;
  // 主题 / 字号变更不再由本实例订阅（见 lib/terminal-registry 单点订阅刷新所有存活实例），
  // 故无 offTheme / offFontSize 字段，mount 时经 registerTerminal 登记、unmount 时 unregister。
  // 滚动状态回调：视口是否贴底变化时通知 React 壳（驱动「跳到底部」浮钮显隐）。
  onScrollState: ((atBottom: boolean) => void) | null = null;
  // 最近一次通知给壳的贴底状态（避免重复回调）。
  private _lastAtBottom = true;

  // 键盘快捷键处理器（Ctrl/Cmd+V 粘贴、Ctrl/Cmd+Shift+C 复制、Ctrl/Cmd+A 全选）。
  // 绑定在 host 上，卸载时解绑（见 unmount）。
  private _keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  // 拖拽文件落终端：dragover / drop 处理器（绑定在 host，卸载时解绑，见 unmount）。
  // 拖入文件时把绝对路径转义拼接后粘贴（对齐 VS Code 拖拽文件语义）。
  private _dragOverHandler: ((e: DragEvent) => void) | null = null;
  private _dropHandler: ((e: DragEvent) => void) | null = null;

  // 最近一次计算出的 cols/rows，仅在真变时才通知 PTY（对齐 VS Code 整数比较、避免无谓 resize）。
  private _lastCols = 0;
  private _lastRows = 0;

  constructor(opts: XtermTerminalOptions) {
    this.sessionKey = opts.sessionKey;
    // channel 优先；省略时回退为 SessionChannel（与重构前 XtermTerminal 直接调 pi 的会话
    // 数据流行为完全等价）。TerminalPane 等新版调用方显式注入 channel。
    this.channel =
      opts.channel ?? new SessionChannel(opts.pi, opts.sessionKey);
    // 保留 pi 引用仅用于「非会话数据流」功能：剪贴板图片落盘(saveImage)、拖拽文件路径解析
    // (getPathForFile)、写后背压回传(acknowledgeDataEvent)。所有 PTY 输入/输出/退出/resize
    // 数据通信均改走 this.channel（见 terminalChannel.ts）。
    this.pi = opts.pi;
  }

  /**
   * 在首次进入 active 且 host 就绪时挂载终端：构造 xterm、装载 addons、open、锁定渲染器、绑定 IPC。
   * 与 VS Code XtermTerminal._initialization 等价（构造 → loadAddon 系列 → open → webgl）。
   * keep-alive：仅在首次进入时调用一次；后续 active 切换走 setActive，不重建实例。
   */
  mount(host: HTMLElement): void {
    if (this.mounted) return;
    this.host = host;
    this.mounted = true;
    this._initXterm(host);
    this.active = true;
    // 登记到存活终端注册表：主题/字号全局变更由 registry 单点订阅后统一刷新本实例
    // （见 lib/terminal-registry），无需本实例各自订阅 onThemeChange/onFontSizeChange。
    registerTerminal(this);
  }

  /**
   * keep-alive：active 切换时调用，不销毁实例（对齐 VS Code terminalInstance.setVisible）。
   * active=false 时仅标记不可见；active=true 时恢复并立即 refit（对齐 VS Code setVisible 的
   * _resizeDebouncer.flush + _resize），使切回的终端即时用最新尺寸渲染，消除切 tab 回来的
   * 首帧尺寸跳变闪烁。
   */
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (active && this.host && this.term && !this.disposed) {
      // 切回可见：flush 待执行 resize + 立即 resize（对齐 VS Code setVisible）。
      this.resizeDebouncer?.flush();
      this.doResize(true);
      // 隐藏期（visibility:hidden / display:none）WebGL 上下文可能被浏览器回收，
      // 切回时强制 refresh 重绘已有缓冲区内容，避免"切回变空白新终端"。
      // 注意：refresh 必须在 doResize 之后（doResize 可能被零尺寸拦截而跳过），
      // 此处直接用 this.term.rows 以确保至少重绘当前有效行数。
      try { this.term.refresh(0, this.term.rows - 1); } catch { /* 渲染器未就绪边界 */ }
    }
  }

  /** 非 active / 卸载时销毁终端，释放所有监听与定时器。 */
  unmount(): void {
    this.disposed = true;
    if (this._flushTimer != null) clearTimeout(this._flushTimer);
    this._flushTimer = null;
    this.stopBuffering?.();
    this.stopBuffering = null;
    this.dataBufferer?.dispose();
    this.dataBufferer = null;
    this.resizeDebouncer?.dispose();
    this.resizeDebouncer = null;
    this.webglContextLost = false;
    this.webgl = null;
    this.decorationAddon?.dispose();
    this.decorationAddon = null;
    this.markNavigationAddon?.dispose();
    this.markNavigationAddon = null;
    this.searchAddon?.dispose();
    this.searchAddon = null;
    this.serializeAddon?.dispose();
    this.serializeAddon = null;
    this.linkProviderDisposable?.dispose();
    this.linkProviderDisposable = null;
    this.caps = null;
    this.offExit?.();
    this.offExit = null;
    // 主题/字号刷新生效于存活实例（registry 单点订阅），故 unmount 时只需从注册表注销，
    // 不再持有本实例的 offTheme/offFontSize 反注册（避免重复订阅导致的不一致）。
    unregisterTerminal(this);
    // 键盘快捷键走 xterm attachCustomKeyEventHandler，term.dispose 时随实例清理；
    // 这里只清幂等标记，无需手动 removeEventListener（已不再绑 host）。
    this._keydownHandler = null;
    // 拖拽监听绑在 host 上，需手动解绑（否则 host 复用/移除时泄漏）。
    if (this.host && this._dragOverHandler && this._dropHandler) {
      this.host.removeEventListener('dragover', this._dragOverHandler);
      this.host.removeEventListener('drop', this._dropHandler as EventListener);
    }
    this._dragOverHandler = null;
    this._dropHandler = null;
    // 治本：显式释放 WebGL context，避免关闭 tab 卸载实例时 context 泄漏累积。
    // @xterm/addon-webgl 的 dispose() 不调用 WEBGL_lose_context.loseContext()，导致浏览器
    // WebGL context 上限（~16）到达后，新实例 new WebglAddon() 创建失败、降级为 DOM 渲染器；
    // 而 .xterm-viewport 在 DOM 模式下 overflow-y:hidden 禁用了滚动 → “不能滚动”。
    // 在 term.dispose() 前从宿主 canvas 取回 context 并 loseContext（term.element 仍有效）。
    if (this.term?.element) {
      const canvas = this.term.element.querySelector('canvas');
      const gl = (canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')) as WebGLRenderingContext | null;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    }
    try {
      this.term?.dispose();
    } catch {
      /* 已销毁 */
    }
    this.term = null;
    this.fit = null;
    this.opened = false;
    this.mounted = false;
    this.host = null;
  }

  /**
   * 写完成确认（对齐 VS Code _flushXtermData）：轮询确认所有已 term.write 的数据都被 xterm
   * 解析完（_latestWriteSeq === _latestParsedSeq），最多重试若干次。供会话结束/卸载前 await，
   * 避免尾部帧撕裂或丢失。无待写或已销毁时立即 resolve。
   */
  flush(): Promise<void> {
    if (this.disposed || !this.term || this._latestWriteSeq === this._latestParsedSeq) {
      return Promise.resolve();
    }
    let retries = 0;
    return new Promise<void>((resolve) => {
      const tick = () => {
        if (this.disposed || this._latestWriteSeq === this._latestParsedSeq || ++retries > 5) {
          if (this._flushTimer != null) clearTimeout(this._flushTimer);
          this._flushTimer = null;
          resolve();
        } else {
          this._flushTimer = setTimeout(tick, 20);
        }
      };
      this._flushTimer = setTimeout(tick, 20);
    });
  }

  /**
   * 同帧 RIS 重置（对齐 VS Code SeamlessRelaunch 的 triggerSwap 同帧语义）：发全清序列
   * \x1bc。紧随其后的首段写会在 xterm 同一次重绘中呈现，避免「清屏→旧内容残留→重画」的
   * 中间帧闪。用于会话重置/复用时需要彻底清屏的场景（如 onRelink 后需清旧缓冲）。
   */
  resetSameFrame(): void {
    if (!this.term || this.disposed) return;
    this.term.write('\x1bc');
  }

  /** 强制重绘：清空 WebGL 纹理图集并触发一次完整重绘（对齐 VS Code forceRedraw/clearTextureAtlas）。
   * 主题切换 / 字体变更后调用，避免 WebGL 下纹理残留导致旧配色/旧字形闪留。无 WebGL 时静默跳过。 */
  forceRedraw(): void {
    if (!this.term || this.disposed || this.webglContextLost) return;
    try {
      this.webgl?.clearTextureAtlas();
    } catch {
      /* DOM 渲染器或无纹理图集时忽略 */
    }
  }

  /**
   * 主题切换刷新（由 lib/terminal-registry 单点订阅 onThemeChange 后统一调用）。
   * 运行时重新构造 xterm 主题（背景/前景取当前容器 --bg-app / --text），再 forceRedraw 清
   * WebGL 纹理残留，避免旧配色闪留、确保与容器背景严格一致（对齐 VS Code getBackgroundColor）。
   */
  applyTheme(theme: Theme): void {
    if (!this.term || this.disposed) return;
    this.term.options.theme = getTermTheme(theme);
    this.forceRedraw();
  }

  /**
   * 全局字号变化刷新（由 lib/terminal-registry 单点订阅 onFontSizeChange 后统一调用）。
   * 同步 fontSize + resize（cell 度量变化必须重建渲染纹理）+ forceRedraw。
   */
  applyFontSize(size: number): void {
    if (!this.term || this.disposed) return;
    this.term.options.fontSize = size;
    this.doResize(true); // fit + 通知 PTY，对齐窗口尺寸变化时的校准路径。
    this.forceRedraw();
  }

  /** 右键上下文菜单：有选区则复制并清空，否则粘贴（对齐原 handleContextMenu 语义）。
   * 剪贴板读写已由 addon-clipboard 接管（对齐 VS Code 的 ClipboardAddon 装配）；
   * 粘贴直接走 term.paste()，由 addon 从系统剪贴板读取，无需自管 navigator.clipboard。 */
  handleContextMenu(e: { preventDefault: () => void }): void {
    e.preventDefault();
    const term = this.term;
    if (!term) return;
    try {
      if (term.hasSelection()) {
        const text = term.getSelection();
        if (text) navigator.clipboard?.writeText(text).catch(() => {});
        term.clearSelection();
      } else {
        // 无选区：智能粘贴（图片优先，回退文本）。复用 pasteFromClipboard 保证
        // 右键与 Ctrl+V 行为一致（图片落临时文件再粘贴路径，对齐 VS Code 拖拽文件语义）。
        this.pasteFromClipboard().catch(() => {});
      }
    } catch {
      /* 剪贴板不可用（如非安全上下文）时静默跳过 */
    }
  }

  /**
   * 把文本粘贴进终端。直接调用 xterm 的 term.paste()，换行归一化为 \r。
   * bracketed paste 模式由 xterm 的 paste() 内部自动处理（它会在模式开启时自行包裹
   * \x1b[200~...\x1b[201~），**绝不能**在这里手动拼接 escape 序列——否则序列会被当作
   * 字面量发进 PTY，shell 不识别，反而把 `[200~` 原样打印出来（即本次 bug 的根因）。
   */
  pasteText(text: string): void {
    const term = this.term;
    if (!term || this.disposed || !text) return;
    const data = text.replace(/\r?\n/g, '\r');
    term.paste(data);
  }

  /**
   * 绑定「拖文件到终端」交互（在 mount 时调用，绑定到 host DOM）。
   *  - dragover 且 dataTransfer 含 Files：preventDefault + dropEffect='copy'（接管默认拖放，
   *    避免浏览器把文件当导航/下载；非文件拖拽放行，保留终端内拖选）。
   *  - drop 且含 Files：解析每个文件绝对路径（shell-safe 转义、空格拼接）后粘贴（复用 pasteText）。
   * 对齐 VS Code 终端「拖拽文件到终端即插入路径」语义。卸载时由 unmount 解绑。
   */
  private bindDragAndDrop(host: HTMLElement): void {
    if (this._dragOverHandler || this._dropHandler) return; // 幂等
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const types = Array.from(e.dataTransfer.types);
      // 接管两类拖拽：
      //  - 系统文件管理器拖入（types 含 'Files'）；
      //  - 内部文件树节点拖入（自定义 MIME 'application/x-pi-file'）。
      // 文本/其它内部拖拽放行给 xterm。
      if (types.includes('Files') || types.includes(PI_FILE_DRAG_MIME)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const types = Array.from(e.dataTransfer.types);
      const dt = e.dataTransfer as DataTransfer & { getData?: (t: string) => string };
      // 优先处理内部文件树拖入：直接读绝对路径（已归一化，无需再解析）。
      // 现承载 JSON 数组（多选拖拽）以空白分隔拼接；兼容旧版单字符串。
      // 用可选调用兜底：部分测试/旧环境注入的 dataTransfer 可能无 getData 方法。
      const piFile = typeof dt.getData === 'function' ? dt.getData(PI_FILE_DRAG_MIME) : '';
      if (piFile) {
        e.preventDefault();
        let paths: string[] = [];
        try {
          const parsed = JSON.parse(piFile);
          if (Array.isArray(parsed)) paths = parsed.filter((p) => typeof p === 'string');
          else if (typeof parsed === 'string') paths = [parsed];
        } catch {
          // 非 JSON：视为单路径（旧版格式）
          paths = [piFile];
        }
        if (paths.length) {
          const joined = paths.map((p) => this._shellQuote(p)).join(' ');
          this.pasteText(joined);
          // 拖拽落盘后把焦点转移到终端，使其可直接键盘输入（对齐 VS Code）。
          this.term?.focus();
        }
        return;
      }
      // 回退到系统文件管理器拖入（Files）。
      if (!types.includes('Files')) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files ?? []);
      if (!files.length) return;
      this.pasteDroppedFiles(files)
        .catch(() => {})
        .finally(() => this.term?.focus());
    };
    this._dragOverHandler = onDragOver;
    this._dropHandler = onDrop;
    host.addEventListener('dragover', onDragOver);
    host.addEventListener('drop', onDrop as EventListener);
  }

  /**
   * 把拖入的文件列表转成可粘贴的路径串并粘贴（对齐 VS Code 拖拽文件语义）：
   *  - 每个文件必须用【绝对路径】——经 pi.getPathForFile（Electron 31+ 官方 API，同步回绝对路径）
   *    解析；兼容旧 Electron 的 File.path（若 getPathForFile 不可用）。
   *  - 图片也直接用原图绝对路径（不经 saveImage 落临时文件，与 Ctrl+V 图片分支区分）；
   *  - 拿不到绝对路径的文件直接跳过（绝不退化成相对/裸文件名，违背「都用绝对路径」的硬要求）；
   *  - 路径含空格/特殊字符时用双引号包裹（shell-safe）；
   *  - 多个文件用空格拼接，一次性粘贴。
   */
  private async pasteDroppedFiles(files: File[]): Promise<void> {
    const parts: string[] = [];
    for (const f of files) {
      // 绝对路径来源（优先级：webUtils.getPathForFile > 旧版 File.path）。
      let p: string | undefined;
      try {
        p = this.pi.getPathForFile?.(f);
      } catch {
        p = undefined;
      }
      if (!p && (f as any).path) p = (f as any).path as string;
      if (typeof p === 'string' && p) parts.push(this._shellQuote(p));
      // 拿不到绝对路径：跳过该文件（不插入裸文件名）。
    }
    const joined = parts.join(' ');
    if (joined) this.pasteText(joined);
  }

  /** shell-safe 引用：路径含空格或 shell 元字符时用双引号包裹（引号本身转义）。
   * 对齐 VS Code 拖拽文件时对路径的 shellQuoted 处理。 */
  private _shellQuote(p: string): string {
    return /\s|["'`$&|;<>()*?{}\\[\]]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;
  }

  /**
   * 智能粘贴：优先粘贴图片（剪贴板含 image 类型时，把图片落临时文件再粘贴其路径，
   * 模拟 VS Code「拖拽文件到终端」行为）；否则回退到文本粘贴。
   * 对齐 VS Code 终端不支持在 PTY 内渲染图片数据的事实——只接收文件路径。
   */
  async pasteFromClipboard(): Promise<void> {
    const term = this.term;
    if (!term || this.disposed) return;
    try {
      // 优先探测图片：navigator.clipboard.read 返回带类型的 ClipboardItem。
      const items = await (navigator.clipboard as any)?.read?.();
      if (Array.isArray(items)) {
        for (const item of items) {
          const type = item.types?.find((t: string) => t.startsWith('image/'));
          if (type) {
            const blob: Blob = await item.getType(type);
            const ext = type.split('/')[1] || 'png';
            const base64 = await this._blobToBase64(blob);
            const filePath = await this.pi.saveImage?.(base64, ext);
            if (filePath) {
              this.pasteText(filePath);
              return;
            }
          }
        }
      }
    } catch {
      /* 剪贴板读取不可用 / 非安全上下文：回退文本粘贴 */
    }
    // 文本路径：从系统剪贴板读文本并粘贴（bracketed paste 包裹在 pasteText 内完成）。
    const text = await navigator.clipboard?.readText();
    if (text) this.pasteText(text);
  }

  /** Blob → base64（不含 data: 前缀）。用于把剪贴板图片送主进程落盘。 */
  private _blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onloadend = () => {
        const result = reader.result as string;
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.readAsDataURL(blob);
    });
  }

  /** 复制当前选区（对齐 VS Code copySelection）；无选区时不动作。 */
  copySelection(): void {
    const term = this.term;
    if (!term || this.disposed || !term.hasSelection()) return;
    const text = term.getSelection();
    if (text) navigator.clipboard?.writeText(text).catch(() => {});
  }

  /** 全选（对齐 VS Code selectAll）。 */
  selectAll(): void {
    const term = this.term;
    if (!term || this.disposed) return;
    term.focus();
    term.selectAll();
  }

  /** 清除选区（对齐 VS Code clearSelection）。 */
  clearSelection(): void {
    this.term?.clearSelection();
  }

  /**
   * 绑定键盘快捷键（在 mount 时调用，用 xterm 的 attachCustomKeyEventHandler 拦截——
   * 这是 xterm 在所有按键处理“之前”的官方拦截点，先于 xterm 把 Ctrl+V 当 \x16 输入，
   * 命中即返回 false 阻止默认输入，从而让粘贴/复制/全选走我们的逻辑）。
   *   - Ctrl/Cmd+V：智能粘贴（图片优先，回退文本）
   *   - Ctrl/Cmd+Shift+C：复制选区
   *   - Ctrl/Cmd+A：全选
   *   - Shift+Enter：软换行（仅写入 \n 续行，不提交执行；必须在无 Ctrl/Cmd
   *     修饰时命中，故逻辑位于 Ctrl/Cmd 组合键守卫之前）。
   * 注意：bind 在 host 的 keydown 会“晚于”xterm 在 textarea 层的默认处理，导致真实 Ctrl+V
   * 已被 xterm 转成 \x16 输入（见 e2e 复现），故必须用 attachCustomKeyEventHandler。
   */
  private bindKeyShortcuts(_host: HTMLElement): void {
    const term = this.term;
    if (!term || this._keydownHandler) return;
    this._keydownHandler = () => {}; // 幂等标记：已绑定
    const handler = (e: KeyboardEvent): boolean => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey; // Ctrl（Win/Linux）或 Cmd（mac）
      const key = e.key.toLowerCase();
      // Shift+Enter：软换行（仅续行、不提交）。必须“无 Ctrl/Cmd 修饰”才命中，
      // 否则会与各类带修饰的 Enter 组合（如终端某些绑定的 Ctrl+Enter）冲突。
      // 注意：此分支必须在 `if (!mod) return true` 之前，因为 Shift+Enter 不带
      // Ctrl/Cmd，否则会被提前放行而失效。
      // 关键：不能 term.write('\n')——term.write 写入的是 PTY 输出方向（stdout），
      // 运行在 PTY 里的程序（如 pi 编辑器）收不到，只会视觉换行。必须走输入通道
      // pi.input（→ 主进程 pty.write，PTY 输入方向/stdin），与正常按键经 term.onData
      // → pi.input 完全一致。写 \n（LF）而非默认 Enter 的 \r（CR）：readline/bash/zsh
      // 把 LF 当续行收集、CR 才提交，从而在不执行命令的前提下插入换行。
      if (e.key === 'Enter' && e.shiftKey && !mod && !e.altKey) {
        e.preventDefault();
        this.channel.send('\n');
        return false; // 阻止 xterm 把 Enter 当 \r 经 onData 再次送出
      }
      if (!mod) return true;
      // Ctrl/Cmd+V：粘贴（图片优先，回退文本）
      if (key === 'v' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        this.pasteFromClipboard().catch(() => {});
        return false; // 阻止 xterm 把 Ctrl+V 当 \x16 输入
      }
      // Ctrl/Cmd+Shift+C：复制选区（仅精确组合，避免吞掉普通 Ctrl+C）
      if (key === 'c' && e.shiftKey && !e.altKey) {
        e.preventDefault();
        this.copySelection();
        return false;
      }
      // Ctrl/Cmd+A：全选
      if (key === 'a' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        this.selectAll();
        return false;
      }
      return true;
    };
    // 存一份供单测直接验证拦截逻辑（生产无副作用）
    (this as any)._customKeyHandler = handler;
    term.attachCustomKeyEventHandler(handler);
  }

  /** 窗口/侧边栏 resize 时由壳的 ResizeObserver 调用，走分轴防抖 refit。
   * 对齐 VS Code TerminalResizeDebouncer：Y 即时、X 100ms 防抖；不可见时推迟到 idle。
   * 实际尺寸计算与 PTY 通知在 doResize 中完成。 */
  scheduleResize(): void {
    if (this.disposed || !this.fit || !this.term || !this.host) return;
    const proposed = this.fit.proposeDimensions();
    if (!proposed) return;
    // 零尺寸守卫（同 doResize）：Chromium 布局未就绪时跳过
    if (proposed.cols <= 2 && proposed.rows <= 1) return;
    const smallBuffer = this._isSmallBuffer();
    this.resizeDebouncer?.resize(proposed.cols, proposed.rows, false, smallBuffer);
  }

  // —— 装饰 / 导航（对齐 VS Code DecorationAddon / MarkNavigationAddon）——
  /** 注册一行覆盖层装饰（对齐 VS Code DecorationAddon.registerCommandDecoration 的差分 overlay）。
   * 装饰由 marker 锚定到 buffer 行，渲染为 DOM 覆盖层，命令状态变化只更新 overlay 而不进 VT 流。
   * @param marker 锚定到某 buffer 行的标记
   * @param opts 装饰呈现选项（背景/前景色、overview ruler、宽高、anchor）
   * @returns 已注册的 IDecoration，或 undefined（无 term / marker 失效）。可保存用于后续 dispose。 */
  registerLineDecoration(marker: IMarker, opts: IDecorationOptions): IDecoration | undefined {
    if (!this.term || this.disposed || !this.decorationAddon) return undefined;
    try {
      return this.decorationAddon.registerCommandDecoration({ marker }, false, { marker });
    } catch {
      return undefined;
    }
  }

  /** 注册一条 mark 装饰（gutter/overview-ruler）。 */
  registerMarkDecoration(marker: IMarker): IDecoration | undefined {
    if (!this.term || this.disposed || !this.decorationAddon) return undefined;
    try {
      return this.decorationAddon.registerMarkDecoration({ marker });
    } catch {
      return undefined;
    }
  }

  /** 清除全部行覆盖层装饰（对齐 VS Code DecorationAddon.clearDecorations）。命令状态重置/会话清屏时调用。 */
  clearDecorations(): void {
    this.decorationAddon?.clearDecorations();
  }

  /** 滚动到指定 buffer 行（对齐 VS Code MarkNavigationAddon.scrollToLine）。
   * 装饰点击/错误跳转等场景调用，把视口带到目标行。 */
  scrollToLine(line: number): void {
    this.markNavigationAddon?.scrollToLine(line);
  }

  /** 跳到底部：把视口滚动到最新输出（对齐 VS Code 终端视口贴底）。同时通知壳隐藏浮钮。
   * 由 React 壳的「跳到底部」浮钮点击调用。 */
  scrollToBottom(): void {
    if (!this.term || this.disposed) return;
    this.term.scrollToBottom();
    this.notifyScrollState();
  }

  /**
   * 保存当前滚动位置的全量快照（对齐 Orca captureScrollState）。
   * 包含：viewportY（绝对行号）、baseY（滚动缓冲区总行数）、wasAtBottom（是否贴底）、
   * 以及 xterm.registerMarker 创建的物理 marker（在 resize 后仍能跟踪逻辑行）。
   * 返回完整快照，恢复时先用 marker（精确），marker 失效后回退到绝对行号。
   */
  captureScrollState(): { viewportY: number; baseY: number; wasAtBottom: boolean; marker?: IMarker } | null {
    if (!this.term || this.disposed) return null;
    const buf = this.term.buffer.active;
    const viewportY = buf.viewportY;
    const baseY = buf.baseY;
    const wasAtBottom = viewportY >= baseY;
    let marker: IMarker | undefined;
    if (!wasAtBottom) {
      const offset = viewportY - (baseY + buf.cursorY);
      try {
        const m = this.term.registerMarker(offset);
        if (m) marker = m;
      } catch { /* marker 注册失败静默忽略 */ }
    }
    return { viewportY, baseY, wasAtBottom, marker };
  }

  /**
   * 恢复滚动位置（对齐 Orca restoreTerminalStructuralScrollIntent）。
   * 优先用 marker.line（精确到逻辑行），marker 失效后回退到绝对行号 viewportY。
   * 如果 wasAtBottom 为 true 或计算后目标行超出范围，scrollToBottom。
   */
  restoreScrollState(state: { viewportY: number; baseY: number; wasAtBottom: boolean; marker?: IMarker | null } | null): void {
    if (!this.term || this.disposed || !state) return;
    if (state.wasAtBottom) {
      this.term.scrollToBottom();
      return;
    }
    // 优先用 marker（精确逻辑行跟踪）
    if (state.marker && state.marker.line >= 0) {
      this.term.scrollToLine(state.marker.line);
      return;
    }
    // marker 失效回退到绝对行号
    const buf = this.term.buffer.active;
    const targetY = Math.min(state.viewportY, buf.baseY);
    this.term.scrollToLine(targetY);
  }

  /** 终端内查找：前/后搜索（对齐 VS Code XtermTerminal.findNext/findPrevious + SearchAddon）。
   * 由 React 壳的查找面板调用；首次调用时 searchAddon 已在 mount 预装载。
   * @returns 是否命中（驱动面板显示「无结果」）。 */
  findNext(termStr: string, options?: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean }): boolean {
    if (!this.searchAddon || this.disposed) return false;
    return this.searchAddon.findNext(termStr, {
      regex: options?.regex ?? false,
      caseSensitive: options?.caseSensitive ?? false,
      wholeWord: options?.wholeWord ?? false,
    });
  }
  findPrevious(termStr: string, options?: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean }): boolean {
    if (!this.searchAddon || this.disposed) return false;
    return this.searchAddon.findPrevious(termStr, {
      regex: options?.regex ?? false,
      caseSensitive: options?.caseSensitive ?? false,
      wholeWord: options?.wholeWord ?? false,
    });
  }

  /** 序列化当前滚动缓冲区（对齐 VS Code SerializeAddon + XtermSerializer）。
   * 返回可 replay 的 VT 数据流字符串；未装载序列化 addon 时返回 null。 */
  serializeScrollback(): string | null {
    if (!this.serializeAddon || this.disposed || !this.term) return null;
    try {
      return this.serializeAddon.serialize({ scrollback: (this.term as any).options?.scrollback ?? getScrollback() });
    } catch {
      return null;
    }
  }

  /** 还原滚动缓冲区（对齐 VS Code triggerReplay / reviveTerminalProcesses 的 initialText replay）。
   * 把 serializeScrollback 产出的 VT 数据流重新写回终端。仅在 mount 后、首次数据到达前调用。 */
  restoreScrollback(data: string): void {
    if (!data || this.disposed || !this.term) return;
    try {
      this.term.write(data);
    } catch {
      /* 还原失败忽略 */
    }
  }

  /** 注册终端内链接 provider（对齐 VS Code TerminalLinkManager.registerLinkProvider）。
   * 实现 xterm ILinkProvider：对指定 buffer 行调用 detectLinksInLine，把命中转为 xterm ILink。
   * 点击 file 链接 → pi.fsOpenWithSystem + onOpenFile 回调；点击 url → pi.openExternal。
   * 返回反注册函数（unmount 时调用）。 */
  private _registerTerminalLinkProvider(term: Terminal): { dispose: () => void } {
    // 检测是否为 Windows 平台（用于链接检测中的路径解析）。
    const isWindows = navigator.platform?.toLowerCase().includes('win') ?? false;
    const provider = {
      provideLinks: (bufferLineNumber: number, cb: (links: any[] | undefined) => void) => {
        if (this.disposed || !term.buffer) {
          cb(undefined);
          return;
        }
        const line = term.buffer.active.getLine(bufferLineNumber - 1);
        const text = line?.translateToString(true) ?? '';
        // 相对路径解析：用当前 cwd（来自 CwdDetectionCapability）补全。
        const cwd = this.caps?.get<CwdDetectionCapability>(TerminalCapability.CwdDetection)?.cwd;
        const resolvePath = (p: string): string => {
          if (!cwd) return p;
          if (p.startsWith('./')) return cwd.replace(/[\\/]+$/, '') + '/' + p.slice(2);
          if (p.startsWith('../')) {
            // 仅处理单层 ..，递归上溯用 URL 归一化
            try { return new URL(p, 'file://' + cwd + '/').pathname; } catch { return p; }
          }
          if (p === '~' || p.startsWith('~/')) return p; // 主目录本项目不解析，保持原样
          return p;
        };
        const matches = detectLinksInLine(text, isWindows, resolvePath);
        if (!matches.length) {
          cb(undefined);
          return;
        }
        const links = matches.map((m) => {
          const built = buildLink(m, {
            openFile: (path, lineNum, colNum) => {
              // 先在 pi-desktop 编辑器中打开（通过 onOpenFile 回调），
              // 若编辑器不可用则回退到系统默认程序。
              if (this.onOpenFile) {
                this.onOpenFile(path, lineNum, colNum);
              } else {
                this.pi.fsOpenWithSystem?.(path).catch(() => {});
              }
            },
            openExternal: (url) => {
              // 使用 pi.openExternal（主进程 app:openExternal），
              // 已改用 child_process.exec 绕过 Electron 的 shell.openExternal 安全对话框。
              this.pi.openExternal(url).catch(() => {});
            },
          });
          // 填充绝对行号（detectLinks 只给列号，行号由 provider 上下文提供）。
          return {
            range: {
              start: { x: built.range.start.x, y: bufferLineNumber },
              end: { x: built.range.end.x, y: bufferLineNumber },
            },
            text: built.text,
            activate: built.activate,
            hover: built.hover,
            leave: built.leave,
            decorations: built.decorations,
          };
        });
        cb(links);
      },
    };
    return term.registerLinkProvider(provider as any);
  }

  /** 当前视口是否贴底（对齐 VS Code：viewportY >= baseY 即贴底）。xterm 6 WebGL 下
   * scrollTop 恒为 0，故用 buffer 的 viewportY/baseY 判定，而非 DOM 原生 scroll。 */
  private isAtBottom(): boolean {
    const buf = (this.term as any)?.buffer?.active;
    if (!buf) return true;
    return buf.viewportY >= buf.baseY - 1;
  }

  /** 视口贴底状态变化时通知 React 壳（驱动浮钮显隐），仅在状态翻转时回调以省渲染。 */
  private notifyScrollState(): void {
    if (!this.onScrollState) return;
    const atBottom = this.isAtBottom();
    if (atBottom === this._lastAtBottom) return;
    this._lastAtBottom = atBottom;
    this.onScrollState(atBottom);
  }

  /** 判断是否「小 buffer」（对齐 VS Code StartDebouncingThreshold=200）。
   * VS Code 用 buffer 当前行数 < 200 直接立即 resize；本项目用同样的 buffer 行数阈值近似，
   * 而非时间窗——静止期（无输出）若 buffer 行数多（如全屏 TUI 整屏常满）仍走 X 防抖，避免
   * 高速输出期每帧因列宽微变触发整屏重排。 */
  private _isSmallBuffer(): boolean {
    const len = (this.term as any)?.buffer?.active?.length;
    return typeof len === 'number' ? len < 200 : true;
  }

  // —— 私有实现 ——

  private _lastWriteAt = 0;

  /** 构造 xterm、装载 addons、open、锁定渲染器、绑定 IPC（mount 内部调用一次）。 */
  private _initXterm(host: HTMLElement): void {
    const term = new Terminal({
      allowProposedApi: true, // 启用提案 API（pi-tui 使用同步输出 ?2026 APM 序列所需）
      // 初始维度：VS Code 构造时即传入 cols/rows，避免 0 尺寸下的首帧测量异常；
      // 随后由 doResize(true) 用 FitAddon 测量宿主尺寸对齐。
      cols: 80,
      rows: 24,
      // Alt+点击移动光标：对齐 VS Code 默认 false（依赖 multiCursorModifier，本应用无此绑定）。
      altClickMovesCursor: false,
      // 日志级别：对齐 VS Code 精神（生产按日志级别收敛），'off' 避免 xterm 内部 console 噪音。
      logLevel: 'off',
      // 不开启 convertEol。PTY 已输出标准 \r\n，convertEol 会把裸 \n 也转 \r\n，
      // 在 pi-tui 差分渲染里偶尔多出回车字节，导致行错位/重排式闪烁。VS Code 终端同样不对 PTY 数据开 convertEol。
      cursorBlink: true,
      // VS Code 默认 cursorStyle: 'bar'（terminal.integrated.cursorStyle 默认 'bar'）。
      cursorStyle: 'bar',
      // 非活跃光标样式：对齐 VS Code 默认 'outline'（光标停在非激活面板时不闪烁实心）。
      cursorInactiveStyle: 'outline',
      // minimumContrastRatio 对齐 VS Code 默认（1）。过高会让 xterm 每帧重算 cell 前景对比度，
      // 流式时增加重绘；VS Code 默认 1。
      minimumContrastRatio: 1,
      drawBoldTextInBrightColors: true,
      // 字重：对齐 VS Code 默认（normal / bold），避免依赖 xterm 隐式默认导致平台差异。
      fontWeight: 'normal',
      fontWeightBold: 'bold',
      letterSpacing: 0,
      tabStopWidth: 8,
      // 回归 VS Code 默认 true：pi-tui 每帧 fullRender(true) 发 ED2（Erase in Display）清屏时，
      // 把整屏旧内容推入 scrollback（VS Code 标准行为）。恢复标准后由 xterm 原生贴底与分轴
      // resize 处理「清屏→重画」的过渡，不再需要此前 scrollOnEraseInDisplay:false 的反向 hack。
      scrollOnEraseInDisplay: true,
      // 滚轮/快速滚动灵敏度：对齐 VS Code 默认（fastScrollSensitivity 5 / scrollSensitivity 1）。
      fastScrollSensitivity: 5,
      scrollSensitivity: 1,
      // 关闭平滑滚动：始终为 0，避免物理滚轮/触控板滚动时的平滑动画与拖影。
      smoothScrollDuration: 0,
      // macOS 选项键行为：对齐 VS Code 默认 false（electron 桌面端行为一致）。
      macOptionIsMeta: false,
      macOptionClickForcesSelection: false,
      // 右键选择单词：对齐 VS Code 默认 false（你的 handleContextMenu 已自定义右键语义）。
      rightClickSelectsWord: false,
      // 词分隔符：对齐 VS Code 默认，保证双击选词/链接检测一致。
      wordSeparator: " ()[]{}\',\"\`─‘’“”|",
      // 忽略 bracketed paste 模式：对齐 VS Code 默认 false（粘贴时由 addon-clipboard 接管）。
      ignoreBracketedPasteMode: false,
      // 重叠字形重缩放：对齐 VS Code 默认 true。改善重叠/组合字形（部分 CJK、组合字符）的
      // cell 度量，从源头减少中英混排与字形重叠时的度量跳变（正对 WebGL 度量抖动根因）。
      rescaleOverlappingGlyphs: true,
      // 不启用透明度（你用实色主题背景，allowTransparency 会引发合成层开销与过滚动露黑边）。
      allowTransparency: false,
      // 窗口尺寸查询：对齐 VS Code 默认开启，使 TUI 能经 escape 序列获取像素/字符尺寸。
      windowOptions: {
        getWinSizePixels: true,
        getCellSizePixels: true,
        getWinSizeChars: true,
      },
      // 用户滚动后输入是否跳回底部：对齐 VS Code 默认 true（全屏 TUI 本就无手动滚动，保持默认）。
      scrollOnUserInput: true,
      // 光标行重排：对齐 VS Code 默认 true（resize 时光标所在行内容重排，避免错位）。
      reflowCursorLine: true,
      // 自定义字形（连字/组合字渲染）：对齐 VS Code 默认 true。
      customGlyphs: true,
      // 滚动条：xterm 6 无 scrollbar option；本应用全屏 TUI 且 CSS 已 overflow:hidden，
      // 原生/内部滚动条均禁用，滑块配色由 theme.scrollbarSlider* 注入（见 theme.ts）。
      fontFamily: FONT_MONO,
      // 跟随全局字体大小（fontSize.ts）：默认基准 13px，可 8–28px 调节。
      fontSize: getFontSize(),
      // lineHeight 对齐 VS Code 默认 1.0（VS Code 终端默认行高 1.0）。
      lineHeight: 1.0,
      scrollback: getScrollback(),
      // 背景色跟随容器 --bg-app（对齐 VS Code getBackgroundColor 的「与容器像素一致」语义，
      // 由 theme.ts 的 TERM_THEMES 在运行时读取，见 theme.ts）。
      theme: TERM_THEMES[getTheme()],
      // 链接处理器（对齐 VS Code TerminalLinkManager 的 linkHandler）：
      // 拦截 xterm 原生 OSC 8 超链接（如 pi 会话中 AI 输出的 Markdown 链接），
      // 防止 xterm 默认行为弹安全对话框，改为走 pi.openExternal。
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (event, text) => {
          // 检查修饰键（Ctrl/Cmd+click 才激活）
          if (!event || !(event.ctrlKey || event.metaKey)) return;
          // 提取 scheme 判断类型
          const colonIdx = text.indexOf(':');
          if (colonIdx === -1) return;
          const scheme = text.substring(0, colonIdx);
          // file:// 链接：走文件打开（忽略安全警告）
          if (scheme === 'file') {
            const path = decodeURIComponent(text.slice('file://'.length));
            if (this.onOpenFile) {
              this.onOpenFile(path);
            } else {
              this.pi.fsOpenWithSystem?.(path).catch(() => {});
            }
            return;
          }
          // http/https/mailto 等：走 pi.openExternal（已改用 child_process.exec）
          this.pi.openExternal(text).catch(() => {});
        },
        hover: (event, text, range) => {
          // 显示工具提示（对齐 linkProvider 的 buildLink hover 行为）
          const doc = document;
          const existing = doc.querySelector('.terminal-link-tooltip');
          if (existing) existing.remove();

          const tooltipEl = doc.createElement('div');
          tooltipEl.className = 'terminal-link-tooltip';
          tooltipEl.textContent = 'Ctrl+click 打开链接';
          tooltipEl.style.cssText = `
            position: fixed;
            left: ${event.clientX}px;
            top: ${event.clientY - 28}px;
            background: var(--bg-over, #2d2d2d);
            color: var(--text, #fff);
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 12px;
            pointer-events: none;
            z-index: 1000;
            white-space: nowrap;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
            opacity: 0;
            transition: opacity 0.15s ease;
          `;
          doc.body.appendChild(tooltipEl);
          requestAnimationFrame(() => {
            tooltipEl.style.opacity = '1';
          });
        },
        leave: () => {
          // 移除工具提示
          const tooltip = document.querySelector('.terminal-link-tooltip');
          if (tooltip) tooltip.remove();
        },
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    this.term = term;
    this.fit = fit;

    // Unicode11Addon：宽字符 / CJK 度量由 xterm 原生处理（对齐 VS Code _updateUnicodeVersion），
    // 从源头消除中英混排度量漂移，替代此前含 CJK 的字体栈 hack。
    try {
      term.loadAddon(new Unicode11Addon());
    } catch {
      /* addon 加载失败不影响核心终端 */
    }

    // ClipboardAddon：由官方 addon 接管系统剪贴板的复制/粘贴（对齐 VS Code 的 ClipboardAddon
    // 装配，替代此前自管 navigator.clipboard 的 handleContextMenu 逻辑）。
    try {
      term.loadAddon(new ClipboardAddon());
    } catch {
      /* addon 加载失败不影响核心终端 */
    }

    // 装饰 / 导航 addons（对齐 VS Code DecorationAddon / MarkNavigationAddon 装载）。
    try {
      this.decorationAddon = new DecorationAddon();
      term.loadAddon(this.decorationAddon);
    } catch {
      this.decorationAddon = null;
    }
    try {
      this.markNavigationAddon = new MarkNavigationAddon();
      term.loadAddon(this.markNavigationAddon);
    } catch {
      this.markNavigationAddon = null;
    }

    // shell integration capability（对齐 VS Code ShellIntegrationAddon 激活后创建的 store）：
    // 命令检测 + cwd 检测。命令 marker 用 xterm.registerMarker(0) 锚定当前行。
    this.caps = new TerminalCapabilityStore();
    const cmdCap = new CommandDetectionCapability(() => {
      try { return (term as any).registerMarker?.(0); } catch { return undefined; }
    });
    cmdCap.onCommandFinished((c) => { if (c.command) this.onCommandFinished?.(c.command); });
    const cwdCap = new CwdDetectionCapability();
    cwdCap.onDidChangeCwd((cwd) => { this.onCwdChange?.(cwd); });
    this.caps.add(TerminalCapability.CommandDetection, cmdCap);
    this.caps.add(TerminalCapability.CwdDetection, cwdCap);

    // open（对齐 VS Code attachToElement: raw.open 在前，webgl 在其后装载）。
    try {
      term.open(host);
      this.opened = true;
    } catch {
      /* jsdom/headless: ignore open failures */
    }

    // 渲染器策略（S1）：open 之后探测 WebGL 可用性并锁定（会话内恒定、不中途切换）。
    // 对齐 VS Code attachToElement 的原生顺序（VS Code 自身也标注「TODO: Move before open」），
    // 但本项目保留 rendererLocked，避免「open 后加载 → 中途切换」的度量跳变风险。
    this.enableWebgl();

    // 查找 addon（对齐 VS Code SearchAddon 装载）：预装载以便 Ctrl+F 即用。
    try {
      this.searchAddon = new SearchAddon();
      term.loadAddon(this.searchAddon);
    } catch {
      this.searchAddon = null;
    }

    // 滚动缓冲区序列化 addon（对齐 VS Code @xterm/addon-serialize）：用于窗口关闭/终端重建时
    // 保存 scrollback，重开时 replay 还原（见 serializeScrollback / restoreScrollback）。
    try {
      this.serializeAddon = new SerializeAddon();
      term.loadAddon(this.serializeAddon);
    } catch {
      this.serializeAddon = null;
    }

    // 终端内链接 provider（对齐 VS Code TerminalLinkManager 的 registerLinkProvider）：
    // 识别 file/url 链接，file → onOpenFile（编辑器），url → window.open（保留用户手势，
    // 经 setWindowOpenHandler → shell.openExternal 打开）。
    // 并回传 onOpenFile 供文件树定位。
    try {
      this.linkProviderDisposable = this._registerTerminalLinkProvider(term);
    } catch {
      this.linkProviderDisposable = null;
    }

    // 写完成确认计数器：xterm 每解析完一批写数据即递增解析序号（对齐 VS Code onWriteParsed）。
    try {
      (term as any).onWriteParsed?.(() => { this._latestParsedSeq = this._latestWriteSeq; });
    } catch {
      /* 旧版 xterm 无 onWriteParsed：降级为「写即解析」，flush 立即 resolves */
    }

    // 滚动状态：xterm 视口随输出/滚轮变化时经 onScroll 驱动浮钮显隐。
    try {
      term.onScroll(() => this.notifyScrollState());
    } catch {
      /* 旧版 xterm 无 onScroll：降级为始终贴底，浮钮不出现 */
    }
    // 初始状态：新终端默认贴底。
    this._lastAtBottom = true;

    // 输入：终端按键 → pi.input → 主进程 pty.write。
    // 注：window.__piOnDataSpy 是可选的测试钩子（e2e 用它观测真实写入 PTY 的字节），
    // 生产中不存在该字段，无副作用。
    term.onData((d) => {
      const spy = (window as any).__piOnDataSpy;
      if (typeof spy === 'function') spy(d);
      this.channel.send(d);
    });

    // 输出：主进程 pty 数据 → TerminalDataBufferer（5ms 时间窗聚合）→ handleProcessData。
    this.dataBufferer = new TerminalDataBufferer((id, data) => this.handleProcessData(id, data));
    this.stopBuffering = this.dataBufferer.startBuffering(
      this.sessionKey,
      // channel.onData 已按 key 过滤并只回传 (data)；这里补回 sessionKey 作为缓冲 id，
      // 使 downstream dataBufferer / handleProcessData 的 (id, data) 契约与原实现一致。
      (handler) => this.channel.onData((data) => handler(this.sessionKey, data)),
      WRITE_DEBOUNCE_MS,
    );

    // 进程退出（含会话结束 onStatus('dead')）统一走 channel.onExit：exit 即 dead，语义等价。
    // 收尾 resize 对齐视口（原 onStatus('dead') 行为）。集成终端 exit 时壳已 unmount，无副作用。
    this.offExit = this.channel.onExit(() => {
      this.doResize(true);
    });
    // 主题切换 / 全局字号变化不再由本实例订阅（见 lib/terminal-registry 单点订阅刷新所有存活实例）；
    // 初始主题 / 字号在 _initXterm 构造 term 时已取当前值（theme: TERM_THEMES[getTheme()]、fontSize: getFontSize()），
    // 后续变更经 registry → applyTheme / applyFontSize 刷新本实例。

    // resize 分轴防抖器（对齐 VS Code TerminalResizeDebouncer）。
    this.resizeDebouncer = new TerminalResizeDebouncer(
      () => this.active,
      (cols, rows) => this._resizeBoth(cols, rows),
      (cols) => this._resizeX(cols),
      (rows) => this._resizeY(rows),
    );

    // 键盘快捷键：Ctrl/Cmd+V 粘贴、Ctrl/Cmd+Shift+C 复制、Ctrl/Cmd+A 全选（绑定到 host DOM）。
    this.bindKeyShortcuts(host);

    // 拖拽文件到终端：拖入即插入绝对路径（对齐 VS Code 拖拽文件语义）。
    this.bindDragAndDrop(host);

    this.doResize(true);
  }

  /** 渲染器策略（S1）：open 之后探测 WebGL 可用性并锁定，会话内恒定、绝不中途切换。
   * 可用环境变量 PI_DESKTOP_RENDERER 强制渲染器，用于排查「WebGL cell 度量跳变导致编辑器漂移」：
   *   - 未设置 / 'auto'：探测 WebGL，可用则 GPU，否则 DOM
   *   - 'webgl'：强制 WebGL（不可用则警告并回退 DOM）
   *   - 'dom'：强制 DOM 渲染器（绕过 WebGL，验证是否 WebGL 度量问题）
   *
   * 对齐 VS Code _enableWebglRenderer：注册 onContextLoss，GPU 上下文丢失时不闪退、整会话降级
   * DOM 渲染器（rendererLocked 仍恒定，不切回 WebGL 以免度量再跳变），并在后续 resize/可见时用
   * requestRefreshDimensions 触发一次重新测量（此处由 doResize(true) 承担）。 */
  private enableWebgl(): void {
    const term = this.term;
    if (!term || this.rendererLocked) return;
    this.rendererLocked = true;
    const forced = (import.meta.env?.VITE_PI_DESKTOP_RENDERER ?? '').toLowerCase();
    if (forced === 'dom') {
      console.info('[terminal] 渲染器已按 PI_DESKTOP_RENDERER=dom 强制锁定为 DOM 渲染器。');
      return;
    }
    try {
      const addon = new WebglAddon();
      // 上下文丢失恢复（对齐 VS Code _webglAddon.onContextLoss）：整会话降级 DOM，不重建 WebGL，
      // 避免「丢失→重建→度量跳变」的闪烁链。下次 resize/可见时 doResize(true) 重新校准尺寸。
      addon.onContextLoss(() => {
        this.webglContextLost = true;
        this.webgl?.dispose();
        this.webgl = null;
        console.warn('[terminal] WebGL 上下文丢失，整会话降级为 DOM 渲染器（不重建 WebGL）。');
        // 上下文丢失后 cell 度量由 WebGL 变 DOM，强制一次整屏重测，避免尺寸错位。
        if (this.active && this.host && !this.disposed) this.doResize(true);
      });
      term.loadAddon(addon); // open 后 load：与 VS Code attachToElement 顺序一致
      this.webgl = addon;
      console.info('[terminal] WebGL 渲染器已锁定（open 后启用，会话内不切换）。');
    } catch (e) {
      console.warn(
        '[terminal] WebGL 渲染器不可用，已锁定为 DOM 渲染器（会话内不切换）。\n' +
          '若环境无硬件 GPU，请确认主进程已设置 --enable-unsafe-swiftshader 以启用软件 WebGL。',
        e,
      );
    }
  }


  /** 滚动到指定 buffer 行（对齐 VS Code MarkNavigationAddon.scrollToLine）。（对齐 VS Code TerminalInstance._onProcessData）：
   * 按 shell integration 的 OSC 633 序列（命令开始/结束）做语义切分，各段按序 term.write，
   * 使命令边界成为独立写入单元。xterm 原生处理 ?2026 同步输出序列（DEC 同步输出），会自行
   * 合并未闭合的同步帧再呈现，故无需自研同步帧切分。
   * 写后回传 acknowledgeDataEvent（对齐 VS Code _writeProcessData 的背压流控）。 */
  private handleProcessData(id: string, data: string): void {
    if (id !== this.sessionKey || !this.term) return;
    this._lastWriteAt = Date.now();
    const segments = this._segmentByShellIntegration(data);
    for (const seg of segments) {
      this._writeProcessData(seg);
    }
  }

  /** 按 shell integration 的 OSC 序列切分输入为语义段（对齐 VS Code TerminalInstance._onProcessData）。
   * 匹配 VS Code 系 \x1b]633;A/B/C/D/F/G 与 FinalTerm 系 \x1b]133;A/B/C/D（\x1b]([16]33;...），
   * 在标记边界把数据切成多段，使命令级输出可被差分写入；xterm 原生处理 ?2026 同步输出，
   * 故无需自研同步帧切分。无 OSC 序列时原样返回单段（零开销）。
   * 注意：仅做「输出分段」这一层（消除闪烁），不解析命令/cwd/mark 语义——后者本项目无宿主消费。 */
  private _segmentByShellIntegration(data: string): string[] {
    // 对齐 VS Code 的 /(?<seq>\x1b\][16]33;(?:C|D(?:;\d+)?)\x07)/：
    // [16]33 同时覆盖 VS Code(633) 与 FinalTerm/iTerm(133) 两系标记。
    const re = /\x1b\][16]33;(?:A|B|C|D|F|G)(?:;\d+)?\x07/g;
    const segments: string[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(data)) !== null) {
      if (m.index > last) segments.push(data.slice(last, m.index));
      const seq = m[0];
      segments.push(seq);
      // 路由给命令检测 capability（去掉 \x1b]633; 前缀与 \x07 ST 后缀，对齐 VS Code _doHandleVSCodeSequence）。
      this._routeOscToCapabilities(seq);
      last = m.index + seq.length;
    }
    if (last < data.length) segments.push(data.slice(last));
    return segments.length ? segments : [data];
  }

  /** 把命中的 OSC 633/133 段交给对应 capability 解析（对齐 VS Code ShellIntegrationAddon 的 OSC 路由）。
   * 命令生命周期 A/B/C/D/E → CommandDetectionCapability；属性 P;Cwd= → CwdDetectionCapability。 */
  private _routeOscToCapabilities(seq: string): void {
    if (!this.caps) return;
    // seq 形如 \x1b]633;A\x07 或 \x1b]633;D;0\x07 或 \x1b]633;P;Cwd=/foo\x07
    const body = seq.replace(/^\x1b\]/, '').replace(/\x07$/, '');
    const cmdCap = this.caps.get<CommandDetectionCapability>(TerminalCapability.CommandDetection);
    if (cmdCap?.handleSequence(body)) return;
    const cwdCap = this.caps.get<CwdDetectionCapability>(TerminalCapability.CwdDetection);
    cwdCap?.handleProperty(body);
  }

  /** 写入一段数据并回传背压（对齐 VS Code TerminalInstance._writeProcessData）。
   * 单一 term.write（无行切片/rAF 逐批 hack），回调里推进解析序号 + acknowledgeDataEvent。
   *
   * 对齐 VS Code：写前/写后分别触发 onWillData / onData 事件，并在写前后自动 save/restore
   * 滚动位置，防止新增输出导致用户已上滚的视口意外跳到底部或顶部。 */
  private _writeProcessData(data: string): void {
    if (this.disposed || !this.term) return;
    const term = this.term;
    const seq = ++this._latestWriteSeq;

    // 对齐 VS Code _onWillData：写前通知外部消费者
    this.onWillData?.(data);

    // 对齐 VS Code：写前保存滚动位置，防止写入过程中 xterm 因 buffer 滚动/ED2/ED3 等
    // 操作意外改变视口位置。captureScrollState 使用 marker 做精确逻辑行跟踪。
    const savedState = this.captureScrollState();

    try {
      term.write(data, () => {
        this._latestParsedSeq = Math.max(this._latestParsedSeq, seq);

        // 对齐 VS Code：写后恢复滚动位置（仅当用户曾上滚离底时恢复）
        this.restoreScrollState(savedState);

        // 背压回传（对齐 VS Code AckDataBufferer）：累积消费字符数到阈值再发 IPC，
        // 对齐 VS Code terminalProcessManager.ts 的 CharCountAckSize=5000 累积策略，
        // 减少高频小段 write 回调下的主进程 ↔ 渲染程通信量。
        this._unsentAckChars += data.length;
        while (this._unsentAckChars > FlowControlConstants.CharCountAckSize) {
          this._unsentAckChars -= FlowControlConstants.CharCountAckSize;
          this.pi.acknowledgeDataEvent?.(this.sessionKey, FlowControlConstants.CharCountAckSize);
        }

        // 对齐 VS Code _onData：写解析完毕后通知外部消费者
        this.onData?.(data);
      });
    } catch {
      /* 终端已销毁等边界 */
    }
  }

  /** resize 回调：X/Y 同时变化（立即/小 buffer 路径，对齐 VS Code _resizeBothCallback）。
   * 对齐 VS Code：resize（尤其列宽变化导致的 reflow）会触发 xterm 内部
   * buffer.ydisp = buffer.ybase 重置视口到底部，故在 resize 前后 save/restore 滚动位置。 */
  private _resizeBoth(cols: number, rows: number): void {
    if (this.disposed || !this.fit || !this.term) return;
    const savedState = this.captureScrollState();
    try {
      this.fit.fit();
    } catch {
      /* fit 失败（尺寸为 0 等边界）时跳过 */
    }
    this.restoreScrollState(savedState);
    this._notifyPtyIfChanged();
  }

  /** resize 回调：仅 X（列宽）变化（防抖路径，对齐 VS Code _resizeXCallback）。
   * 对齐 VS Code：列宽变化引发 reflow，可能改变 ybase/ydisp，故 save/restore。 */
  private _resizeX(cols: number): void {
    if (this.disposed || !this.fit || !this.term) return;
    const savedState = this.captureScrollState();
    try {
      this.fit.fit();
    } catch {
      /* fit 失败边界 */
    }
    this.restoreScrollState(savedState);
    this._notifyPtyIfChanged();
  }

  /** resize 回调：仅 Y（行数）变化（即时路径，对齐 VS Code _resizeYCallback）。
   * 对齐 VS Code：xterm 的 resize 内部会重置 buffer.ydisp = buffer.ybase，
   * 导致用户已上滚的视口 snap 到底部，故在 resize 前后 save/restore 滚动位置。 */
  private _resizeY(rows: number): void {
    if (this.disposed || !this.term) return;
    const savedState = this.captureScrollState();
    if (rows !== this.term.rows) {
      try {
        this.term.resize(this.term.cols, rows);
      } catch {
        /* resize 边界 */
      }
    }
    this.restoreScrollState(savedState);
    this._notifyPtyIfChanged();
  }

  /** 仅在 cols/rows 真变时才通知 PTY（对齐 VS Code 整数 dims 比较，避免无谓 resize）。 */
  private _notifyPtyIfChanged(): void {
    if (!this.term) return;
    const { cols, rows } = this.term;
    if (cols === this._lastCols && rows === this._lastRows) return;
    this._lastCols = cols;
    this._lastRows = rows;
    this.channel.resize(cols, rows);
  }

  /** 立即用宿主最新尺寸校准终端并通知 PTY（首挂载 / 切回可见 / 会话结束收尾调用，force=true）。
   * 对齐 VS Code TerminalInstance.setVisible 的 _resize（open 后用真实容器尺寸重测）。
   * 实际的分轴防抖 / 可见性 / idle 调度全部交给 TerminalResizeDebouncer 处理。
   *
   * 零尺寸守卫：当元素刚从 display:none 变为可见时，Chromium 可能尚未完成完整布局，
   * proposeDimensions 会返回最小尺寸（2×1）。此时若 resize 到 2×1，xterm 会截断缓冲区
   * 导致历史输出丢失（issue 07）。当提议列数 ≤2 且行数 ≤1 时跳过 resize，等候
   * ResizeObserver 或下一次调度用真实尺寸校准。 */
  private doResize(force = false): void {
    if (this.disposed || !this.fit || !this.term || !this.host) return;
    const proposed = this.fit.proposeDimensions();
    if (!proposed) return;
    // 零尺寸守卫：Chromium 布局未就绪时返回 2×1 最小值，跳过避免缓冲截断
    if (proposed.cols <= 2 && proposed.rows <= 1) return;
    const smallBuffer = force || this._isSmallBuffer();
    this.resizeDebouncer?.resize(proposed.cols, proposed.rows, force, smallBuffer);
  }
}
