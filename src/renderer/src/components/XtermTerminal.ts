// XtermTerminal —— VS Code 集成终端同款装配（见 docs/adr/0002 / 0003）。
//
// 本次重写把原 XtermTerminal 内大量自研 hack（同步帧切分 / hasOpenSyncFrame / 兜底
// setTimeout / 输出镜像 / cursorBlink 抑制）全部移除，改为对齐 VS Code 集成终端的
// 标准装配：用官方 @xterm 稳定组件（xterm 6.0.0 + addon-webgl + addon-fit +
// addon-clipboard + addon-unicode11）以「开箱即用」的方式驱动，把渲染/缓冲/度量交给
// xterm 本身（VS Code 也是这么做的——它依赖 xterm 原生处理 ?2026 同步输出序列）。
//
// 与 VS Code 集成终端对齐的装配点：
//   - 渲染器：open 前同步探测 WebGL 并 loadAddon，open 后整会话恒定、绝不中途切换
//     （对齐 VS Code XtermTerminal._enableWebglRenderer + 渲染器恒定语义）。
//   - 剪贴板：用官方 @xterm/addon-clipboard 接管复制/粘贴（对齐 VS Code 的
//     ClipboardAddon 装配，替代此前自管 navigator.clipboard 的 handleContextMenu）。
//   - Unicode：加载 Unicode11Addon，使 CJK/宽字符度量稳定（对齐 VS Code 的
//     _updateUnicodeVersion，从根本上消除中英混排度量漂移，替代此前含 CJK 字体栈 hack）。
//   - 数据缓冲：对齐 VS Code 的 TerminalDataBufferer，用固定 5ms 时间窗聚合到达的
//     onData 块，窗口结束一次性 term.write，消除流式高频重绘的中间帧闪烁。
//   - 构造选项：allowProposedApi / scrollOnEraseInDisplay / minimumContrastRatio /
//     drawBoldTextInBrightColors / tabStopWidth / cursorBlink / letterSpacing
//     逐项对齐 VS Code 默认（见 vscode src/xterm/xtermTerminal.ts _initialization）。
//
// 在 0003 之上补齐的防闪烁机制（对齐 VS Code 集成终端，见 task_plan.md）：
//   - keep-alive：TerminalPane 非 active 时不销毁实例，只隐藏；切回时 setActive(true) 立即
//     refit，避免「销毁→重建→WebGL 重探测」带来的切 tab 首帧闪（对齐 VS Code setVisible）。
//   - 写完成确认 flush()：_latestWriteSeq / _latestParsedSeq 计数器 + 轮询，对齐 VS Code
//     _flushXtermData 的「已写入=已解析」闸门，避免尾部帧撕裂/丢失。
//   - 同帧 RIS 重置 resetSameFrame()：对齐 VS Code SeamlessRelaunch 的 \x1bc 同帧语义，
//     会话重置/复用时彻底清屏不闪。
//   - 背景色跟随容器：theme.ts 的 TERM_THEMES.background 改为运行时读 --bg-app 计算值
//     （对齐 VS Code terminalInstance.getBackgroundColor 的「与容器像素一致」语义）。
//
// 对外契约（B2-a 契约保形）：本类只通过构造传入的 pi 接口收发数据，不触碰主进程 / preload /
// IPC 信道名。PTY 链路零接触（见 docs/adr/0002）。
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { getTheme, onThemeChange, TERM_THEMES } from '../theme';
import type { PiApi } from '../ipc';
import '@xterm/xterm/css/xterm.css';

// 终端字体栈：对齐 VS Code 默认（等宽优先）。鉴于已加载 Unicode11Addon 处理宽字符度量，
// 不再需要此前「含 CJK 的等宽字体栈」hack——VS Code 同样不靠字体栈兜底 CJK 度量，而是
// 交给 Unicode11Addon + xterm 原生渲染。移除主栈里的 'Microsoft YaHei Mono'/'Microsoft YaHei'
// 等可变宽 CJK 字体：它们会让 WebGL 渲染器在 CJK 占比变化的帧间出现 cell 度量跳变（全屏
// TUI 差分重绘时表现为整屏上下抖动）。CJK 兜底交由 xterm 的 generic monospace fallback +
// Unicode11Addon 处理，纯 DOM 渲染器路径仍由 CSS 兜底覆盖。
const FONT_MONO =
  "'JetBrains Mono','Fira Code','Cascadia Code',ui-monospace,monospace";

// 对齐 VS Code TerminalDataBufferer 的固定时间窗（5ms）：窗口内累积到达的数据块，
// 窗口结束一次性 term.write，消除流式高频重绘的中间帧闪烁。
const WRITE_DEBOUNCE_MS = 5;
// 单批写入行数上限（对齐 VS Code 聚合 + xterm 高吞吐实践）：一个 5ms 窗口内若洪泛输出
// 数千行（pi-tui 高速 fullRender 常见），不分批会一次性 term.write 数千行 → 触发整屏
// 重绘 + 可能 fit 重排 → 表现为持续跳动。按行切片、批间让出渲染（setTimeout(0)）可把
// 巨量输出摊平到多帧，避免「一次加多行」的整屏抖动。1000 行/批：足够覆盖 TUI 单帧
// （通常远小于此），又远小于无限制的洪泛量。
const WRITE_MAX_LINES = 1000;
// resize 防抖：对齐 VS Code TerminalResizeDebouncer 的 DebounceResizeXDelay(100ms)，
// 且 VS Code 认为「horizontal resize is expensive due to reflow」——改列宽 = 整屏重排，
// 正是流式输出跳动的核心放大器，故列宽变化必须防抖且只在尺寸真变时才触发。
const RESIZE_DEBOUNCE_MS = 100;
// 尺寸变化阈值（像素）：fit 用浮点测量，亚像素抖动会让 proposeDimensions 算出不同
// cols/rows，触发无谓的 terminal.resize() → WebGL handleResize 强制全重绘。小于该阈值的
// 尺寸微动视为「无变化」，跳过 fit（对齐 VS Code 用整数 cols/rows 比较、天然无亚像素抖）。
const RESIZE_PIXEL_THRESHOLD = 2;
// 流式活跃判定：距上次写入超过该时长（ms）才视为「输出间歇」，允许列宽(X)变化。
// 对齐 VS Code「buffer 小/不可见才立即 resize、否则防抖」的思路——高速输出期冻结列宽，
// 避免每帧因 1px 宽度微动触发整屏重排；仅行数(Y)便宜，可即时跟随。
const RESIZE_ACTIVE_GUARD_MS = 200;

export interface XtermTerminalOptions {
  sessionKey: string;
  pi: PiApi;
}

/**
 * 单个会话的 xterm 终端封装。生命周期：
 *   new → mount(host)（首次进入 active 时构造 open + 锁定渲染器 + 绑 IPC）→ setActive(bool)
 *   （切 tab 时 keep-alive，不重建）→ unmount()（真正销毁，如会话被删除）。
 * 对 React 壳完全透明：壳在首次 active 时调用 mount、非 active 时调用 setActive(false)、
 * 再次 active 时调用 setActive(true)，会话删除时调用 unmount()，并把 host div / 置底按钮
 * 的 DOM 事件转交本类。
 */
export class XtermTerminal {
  private readonly sessionKey: string;
  private readonly pi: PiApi;
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private opened = false;
  private mounted = false; // 是否已完成首次 mount（keep-alive 下不再重建）
  private active = false; // keep-alive：当前是否可见（对齐 VS Code setVisible）
  private rendererLocked = false; // 本实例是否已锁定渲染器（open 前探测、open 后不再变）
  private disposed = false;
  private host: HTMLElement | null = null;

  // —— 数据写缓冲（对齐 VS Code TerminalDataBufferer 的 5ms 时间窗聚合）——
  private writeBuffer = '';
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  // 分帧写入链 timer：当单窗口累积数据超 WRITE_MAX_LINES 时，切片后逐批 write，
  // 批间用 requestAnimationFrame 让出渲染（对齐 xterm/VS Code 的帧驱动渲染节奏，每帧最多
  // 一批、每帧只重绘一次），避免一次 write 数千行。与 writeTimer 独立，互不干扰。
  // 类型用 number（浏览器下 setTimeout 与 requestAnimationFrame 均返回 number）。
  private writeChainTimer: number | null = null;
  // 最近一次写入时间戳：用于判定是否处于「流式活跃期」，决定 resize 时是否冻结列宽。
  private lastWriteAt = 0;
  // 独立字段：resize 防抖 timer，绝不能复用 writeTimer（否则 ResizeObserver 会清掉
  // 正在聚合的写操作，导致 PTY 输出永远不写入 xterm —— 见 scheduleResize）。
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  // —— 写完成确认（对齐 VS Code _flushXtermData 的「已写入=已解析」闸门）——
  // 每次 term.write 递增写序号；xterm 解析回调递增解析序号。flush() 轮询确认两者追平，
  // 避免尾部帧在卸载/会话结束前撕裂或丢失。
  private _latestWriteSeq = 0;
  private _latestParsedSeq = 0;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;

  // —— 反注册函数 ——
  private offData: (() => void) | null = null;
  private offStatus: (() => void) | null = null;
  private offTheme: (() => void) | null = null;
  // 滚动状态回调：视口是否贴底变化时通知 React 壳（驱动「跳到底部」浮钮显隐）。
  onScrollState: ((atBottom: boolean) => void) | null = null;
  // 最近一次通知给壳的贴底状态（避免重复回调）。
  private _lastAtBottom = true;

  constructor(opts: XtermTerminalOptions) {
    this.sessionKey = opts.sessionKey;
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
      // 切回可见：立即 refit，用最新宿主尺寸校准（见 doResize 的 force 语义）。
      this.doResize(true);
    }
  }

  /** 非 active / 卸载时销毁终端，释放所有监听与定时器。 */
  unmount(): void {
    this.disposed = true;
    if (this.writeTimer != null) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    if (this.writeChainTimer != null) {
      clearTimeout(this.writeChainTimer);
      cancelAnimationFrame(this.writeChainTimer);
    }
    this.writeChainTimer = null;
    if (this.resizeTimer != null) clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    if (this._flushTimer != null) clearTimeout(this._flushTimer);
    this._flushTimer = null;
    this.writeBuffer = '';
    this.offData?.();
    this.offStatus?.();
    this.offTheme?.();
    this.offData = this.offStatus = this.offTheme = null;
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

  /** 跳到底部：把视口滚动到最新输出（对齐 VS Code 终端视口贴底）。同时通知壳隐藏浮钮。
   * 由 React 壳的「跳到底部」浮钮点击调用。 */
  scrollToBottom(): void {
    if (!this.term || this.disposed) return;
    this.term.scrollToBottom();
    this.notifyScrollState();
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
        // 无选区：从系统剪贴板读取并粘贴。ClipboardAddon 已接管剪贴板读写
        // （对齐 VS Code 的 ClipboardAddon 装配），此处经其提供的 navigator.clipboard 读取。
        navigator.clipboard?.readText().then((text) => {
          if (text) term.paste(text);
        }).catch(() => {});
      }
    } catch {
      /* 剪贴板不可用（如非安全上下文）时静默跳过 */
    }
  }

  /** 窗口/侧边栏 resize 时由壳的 ResizeObserver 调用，走防抖 refit。
   * 防抖时长对齐 VS Code TerminalResizeDebouncer 的 DebounceResizeXDelay(100ms)。 */
  scheduleResize(): void {
    if (this.resizeTimer != null) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => this.doResize(false), RESIZE_DEBOUNCE_MS);
  }

  // —— 私有实现 ——

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
      // 关闭 scrollOnEraseInDisplay：默认 false。pi-tui 每帧 fullRender(true) 发 ED2
      // （Erase in Display）清屏时，若开启会把整屏旧内容推入 scrollback，使 baseY 每帧
      // 被推高、视口在「清屏→重画」间隙短暂不贴底，高速输出时表现为「内容溢出→再跟随」
      // 的持续抖动。关闭后清屏只清视口、不推 scrollback，baseY 稳定，视口锚定当前整屏，
      // 从根上消除向下溢出跟随（见用户反馈的跳动现象）。代价：清屏不保留历史到
      // scrollback——但 pi-tui 是主场景且已移除置底/历史浏览，副作用可接受。
      scrollOnEraseInDisplay: false,
      // 滚轮/快速滚动灵敏度：对齐 VS Code 默认（fastScrollSensitivity 5 / scrollSensitivity 1）。
      fastScrollSensitivity: 5,
      scrollSensitivity: 1,
      // 平滑滚动时长：对齐 VS Code RenderConstants.SmoothScrollDuration(125ms)。仅在有滚轮/
      // 触摸板滚动事件时由 xterm 内部启用平滑动画；全屏 TUI 无手动滚动交互，常态不触发，
      // 不对写入造成拖影。
      smoothScrollDuration: 125,
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
      fontSize: 13,
      // lineHeight 对齐 VS Code 默认 1.0（VS Code 终端默认行高 1.0）。
      lineHeight: 1.0,
      scrollback: 1000,
      // 背景色跟随容器 --bg-app（对齐 VS Code getBackgroundColor 的「与容器像素一致」语义，
      // 由 theme.ts 的 TERM_THEMES 在运行时读取，见 theme.ts）。
      theme: TERM_THEMES[getTheme()],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    this.term = term;
    this.fit = fit;

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
    term.onData((d) => this.pi.input(this.sessionKey, d));

    // 输出：主进程 pty 数据 → 5ms 时间窗聚合 → 一次性 term.write（对齐 VS Code TerminalDataBufferer）。
    this.offData = this.pi.onData((key, data) => this.handleData(key, data));
    this.offStatus = this.pi.onStatus((key, status) => {
      if (key !== this.sessionKey) return;
      if (status === 'dead') this.doResize(true); // 会话结束时收尾 resize，对齐视口
    });
    this.offTheme = onThemeChange((t) => {
      if (this.term) this.term.options.theme = TERM_THEMES[t];
    });

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

    // S1：先锁定渲染器（open 前），再 open，使第一帧即以锁定单元度量渲染，杜绝 open 后
    // 加载 WebGL 导致的度量跳变。整会话渲染器恒定、不切换。
    this.enableWebgl();

    try {
      term.open(host);
      this.opened = true;
    } catch {
      /* jsdom/headless: ignore open failures */
    }
    this.doResize(true);
  }

  /** 渲染器策略（S1）：open 前同步探测 WebGL 可用性，open 后整个会话恒定、绝不中途切换。
   * 可用环境变量 PI_DESKTOP_RENDERER 强制渲染器，用于排查“WebGL cell 度量跳变导致编辑器漂移”：
   *   - 未设置 / 'auto'：探测 WebGL，可用则 GPU，否则 DOM
   *   - 'webgl'：强制 WebGL（不可用则警告并回退 DOM）
   *   - 'dom'：强制 DOM 渲染器（绕过 WebGL，验证是否 WebGL 度量问题） */
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
      term.loadAddon(addon); // open 前 load：第一帧即 GPU 渲染，cell 度量从首帧恒定
      console.info('[terminal] WebGL 渲染器已锁定（open 前启用，会话内不切换）。');
    } catch (e) {
      console.warn(
        '[terminal] WebGL 渲染器不可用，已锁定为 DOM 渲染器（会话内不切换）。\n' +
          '若环境无硬件 GPU，请确认主进程已设置 --enable-unsafe-swiftshader 以启用软件 WebGL。',
        e,
      );
    }
  }

  /** 窗口/侧边栏 resize 时由壳的 ResizeObserver 调用（壳侧已做防抖）。
   *
   * 对齐 VS Code TerminalResizeDebouncer 的分层 resize 思路（见 vscode-src
   * terminalResizeDebouncer.ts）：horizontal resize is expensive due to reflow（改列宽 =
   * 整屏重排 → WebGL handleResize 强制全重绘，正是流式输出跳动的核心放大器），故列宽变化
   * 必须防抖且只在尺寸真变时才触发；vertical resize 便宜，可即时跟随。
   *
   * 关键修复（相对旧实现）：旧实现「先 fit.fit()、再比较 _lastDims」——但 fit.fit() 内部已
   * 调用 terminal.resize() + WebGL handleResize 全重绘，比较在 resize 之后、太晚，导致即使
   * 尺寸未变仍每帧重绘。新实现「先测量→比较阈值→变化才 fit」，且：
   *   1) 亚像素阈值：host 像素尺寸变化 < RESIZE_PIXEL_THRESHOLD 视为无变化，跳过 fit，
   *      消除 fit 浮点测量亚像素抖动引发的反复重排（对齐 VS Code 用整数 cols/rows 比较）。
   *   2) 流式活跃期冻结列宽：距上次写入 < RESIZE_ACTIVE_GUARD_MS 时只跟随行数(Y)、不动列宽(X)，
   *      避免高速输出期因 1px 宽度微动触发整屏重排（对齐 VS Code「buffer 大才防抖」）。
   *   3) force=true（会话结束/首挂载/切回可见）时无视活跃期与阈值，确保收尾/首帧对齐视口。 */
  private doResize(force = false): void {
    const term = this.term;
    const fit = this.fit;
    const host = this.host;
    if (!term || !fit || !host) return;

    // 亚像素阈值：host 像素尺寸变化小于阈值视为「无变化」，跳过 fit（避免无谓重排）。
    const w = host.clientWidth;
    const h = host.clientHeight;
    const lastPx = (this as any)._lastPx as { w: number; h: number } | undefined;
    if (!force && lastPx) {
      if (
        Math.abs(w - lastPx.w) < RESIZE_PIXEL_THRESHOLD &&
        Math.abs(h - lastPx.h) < RESIZE_PIXEL_THRESHOLD
      ) {
        return; // 尺寸微动未超阈值，跳过
      }
    }

    // 流式活跃期：近期有写入则冻结列宽（X 贵），仅允许行数(Y)变化。
    const active = !force && Date.now() - this.lastWriteAt < RESIZE_ACTIVE_GUARD_MS;

    try {
      // 先测量目标 dims（不立即 resize）。非活跃期允许列宽变化；活跃期冻结列宽(X)。
      const proposed = fit.proposeDimensions();
      if (proposed) {
        if (!active) {
          fit.fit(); // 正常 fit：列宽可随容器变化
        } else {
          // 活跃期冻结列宽：仅行数跟随（用 propose 出的 rows），列宽锁定为 term.cols，
          // 不调 fit 改 X → 不触发 WebGL 整屏重排。
          if (proposed.rows !== term.rows) term.resize(term.cols, proposed.rows);
        }
      }
    } catch {
      /* fit/propose 失败（尺寸为 0 等边界）时跳过 */
    }

    const { cols, rows } = term;
    const last = (this as any)._lastDims as { cols: number; rows: number } | undefined;
    if (!force && last && last.cols === cols && last.rows === rows) {
      return; // 目标 dims 与上次相同，无需通知 PTY resize
    }
    (this as any)._lastDims = { cols, rows };
    (this as any)._lastPx = { w, h };
    this.pi.resize(this.sessionKey, cols, rows);
  }

  /** 收到 PTY 数据：对齐 VS Code TerminalDataBufferer，用 5ms 固定时间窗聚合到达的数据块，
   * 窗口结束一次性取出累积数据，再按 WRITE_MAX_LINES 切片、逐批 term.write（批间让出渲染）。
   * 这样即便一个窗口内洪泛输出数千行（pi-tui 高速 fullRender 常见），也不会「一次 write 灌入
   * 数千行」触发整屏重绘 + 可能 fit 重排的跳动，而是摊平到多帧、每帧只增有限行。
   * xterm 原生支持 ?2026 同步输出序列（DEC 同步输出），会自行合并未闭合的同步帧再呈现，
   * 故不再需要此前自研的同步帧切分 / hasOpenSyncFrame / 兜底 setTimeout 逻辑。
   *
   * 写后锁底：每批 term.write 后，若写前视口已贴底则立即 scrollToBottom()。消除「新行先写入
   * scrollback、xterm 原生贴底跟随要等下一渲染帧才滚下」的时间窗——高速输出时该时间窗表现为
   * 「内容溢出→再跟随」的持续抖动（见用户反馈的跳动现象）。仅当写前已贴底时锁底，避免把用
   * 滚轮上滚看历史的用户强行拽回底部。 */
  private handleData(key: string, data: string): void {
    if (key !== this.sessionKey || !this.term) return;
    this.writeBuffer += data;
    this.lastWriteAt = Date.now(); // 记录数据到达时刻，供 resize 判定是否处于流式活跃期。
    if (this.writeTimer != null) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      if (this.disposed || !this.term) return;
      const term = this.term;
      const buf = this.writeBuffer;
      this.writeBuffer = '';
      // 写前是否在底部：整批来自同一窗口，贴底状态连续，仅首批前算一次。
      const atBottomBefore =
        (term as any).buffer?.active?.viewportY >= (term as any).buffer?.active?.baseY - 1;
      this.flushBatched(term, buf, atBottomBefore);
    }, WRITE_DEBOUNCE_MS);
  }

  /** 把窗口累积数据按 WRITE_MAX_LINES 切片，串行逐批 term.write（批间 requestAnimationFrame
   * 让出渲染）。避免单次 write 数千行导致的整屏重绘抖动。
   * 批间用 rAF 而非 setTimeout(0)：对齐 xterm/VS Code 的帧驱动渲染节奏，使每批写入落在帧边界、
   * 每帧最多重绘一次，彻底消除「一帧内多次 write 引发的中间帧闪烁」。
   * 每批写后按需锁底。 */
  private flushBatched(term: Terminal, data: string, atBottomBefore: boolean): void {
    if (this.disposed) return;
    // 按行切片：保留行尾 \n，使每段都是完整行（TUI 序列不被切断）。
    const lines = data.split(/(\n)/); // 捕获分组：奇数索引为分隔符 \n
    let batch = '';
    let lineCount = 0;
    let i = 0;
    const writeNextBatch = () => {
      if (this.disposed || !this.term) return;
      // 累积到一批（WRITE_MAX_LINES 行）或耗尽所有行。
      while (i < lines.length) {
        batch += lines[i];
        // 分隔符 \n 出现在奇数位，计为一行结束。
        if (i % 2 === 1) {
          lineCount++;
          if (lineCount >= WRITE_MAX_LINES) break;
        }
        i++;
      }
      if (batch.length === 0) return; // 无更多数据
      const chunk = batch;
      batch = '';
      // 递增写序号（对齐 VS Code _latestXtermWriteData）；回调里递增解析序号（见 onWriteParsed 注册）。
      const seq = ++this._latestWriteSeq;
      try {
        term.write(chunk, () => {
          // xterm 解析完本批：把解析序号推到本次写序号（多批在队列中时取最大已解析）。
          this._latestParsedSeq = Math.max(this._latestParsedSeq, seq);
        });
      } catch {
        /* 终端已销毁等边界 */
      }
      if (atBottomBefore) term.scrollToBottom();
      // 写前贴底时锁底后，视口回到底部 → 状态可能翻转（如从非底写回底），通知壳。
      this.notifyScrollState();
      // 还有剩余行：让出渲染一帧（对齐帧边界，每帧最多一批）再写下一批，摊平巨量输出。
      // 兜底：测试/jsdom 等无 rAF 环境降级到 setTimeout(0)，行为等价。
      if (i < lines.length) {
        const raf = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number;
        this.writeChainTimer = raf(writeNextBatch);
      }
    };
    writeNextBatch();
  }
}
