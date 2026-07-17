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
// 交给 Unicode11Addon + xterm 原生渲染。保留系统等宽中文作兜底以覆盖纯 DOM 渲染器路径。
const FONT_MONO =
  "'JetBrains Mono','Fira Code','Cascadia Code',ui-monospace,'Microsoft YaHei Mono','Microsoft YaHei',monospace";

// 对齐 VS Code TerminalDataBufferer 的固定时间窗（5ms）：窗口内累积到达的数据块，
// 窗口结束一次性 term.write，消除流式高频重绘的中间帧闪烁。
const WRITE_DEBOUNCE_MS = 5;

export interface XtermTerminalOptions {
  sessionKey: string;
  pi: PiApi;
}

/**
 * 单个会话的 xterm 终端封装。生命周期：
 *   new → mount(host)（active 时 open + 锁定渲染器 + 绑 IPC）→ unmount()（dispose）。
 * 对 React 壳完全透明：壳只负责在 active 时调用 mount、非 active 时调用 unmount，
 * 以及把 host div / 置底按钮的 DOM 事件转交本类。
 */
export class XtermTerminal {
  private readonly sessionKey: string;
  private readonly pi: PiApi;
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private opened = false;
  private rendererLocked = false; // 本实例是否已锁定渲染器（open 前探测、open 后不再变）
  private disposed = false;
  private host: HTMLElement | null = null;

  // —— 数据写缓冲（对齐 VS Code TerminalDataBufferer 的 5ms 时间窗聚合）——
  private writeBuffer = '';
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  // 独立字段：resize 防抖 timer，绝不能复用 writeTimer（否则 ResizeObserver 会清掉
  // 正在聚合的写操作，导致 PTY 输出永远不写入 xterm —— 见 scheduleResize）。
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  // —— 置底按钮可见性回调（壳订阅）——
  private showJumpCb: ((show: boolean) => void) | null = null;
  // xterm 的 onScroll 返回 IDisposable（非函数），用 disposer 包装以便统一反注册。
  private offScroll: (() => void) | null = null;

  // —— 反注册函数 ——
  private offData: (() => void) | null = null;
  private offStatus: (() => void) | null = null;
  private offTheme: (() => void) | null = null;

  constructor(opts: XtermTerminalOptions) {
    this.sessionKey = opts.sessionKey;
    this.pi = opts.pi;
  }

  /** 订阅“未贴底”状态变化，供 React 壳渲染置底按钮。 */
  onShowJump(cb: (show: boolean) => void): void {
    this.showJumpCb = cb;
  }

  /**
   * 在 active 且 host 就绪时挂载终端：构造 xterm、装载 addons、open、锁定渲染器、绑定 IPC。
   * 与 VS Code XtermTerminal._initialization 等价（构造 → loadAddon 系列 → open → webgl）。
   */
  mount(host: HTMLElement): void {
    if (this.opened) return;
    this.host = host;

    const term = new Terminal({
      allowProposedApi: true, // 启用提案 API（pi-tui 使用同步输出 ?2026 APM 序列所需）
      // 不开启 convertEol。PTY 已输出标准 \r\n，convertEol 会把裸 \n 也转 \r\n，
      // 在 pi-tui 差分渲染里偶尔多出回车字节，导致行错位/重排式闪烁。VS Code 终端同样不对 PTY 数据开 convertEol。
      cursorBlink: true,
      // VS Code 默认 cursorStyle: 'bar'（terminal.integrated.cursorStyle 默认 'bar'）。
      cursorStyle: 'bar',
      // minimumContrastRatio 对齐 VS Code 默认（1）。过高会让 xterm 每帧重算 cell 前景对比度，
      // 流式时增加重绘；VS Code 默认 1。
      minimumContrastRatio: 1,
      drawBoldTextInBrightColors: true,
      letterSpacing: 0,
      tabStopWidth: 8,
      // 对齐 VS Code 的 scrollOnEraseInDisplay: true。Erase in Display(ED2) 时把被擦除的
      // 文本推入 scrollback 而非只清视口，避免 pi-tui 每帧 fullRender(true) 清屏时视口跳动/内容错位。
      scrollOnEraseInDisplay: true,
      fontFamily: FONT_MONO,
      fontSize: 13,
      // lineHeight 对齐 VS Code 默认 1.0（VS Code 终端默认行高 1.0）。
      lineHeight: 1.0,
      scrollback: 5000,
      theme: TERM_THEMES[getTheme()],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    this.term = term;
    this.fit = fit;

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
    this.bindScroll(host);
  }

  /** 非 active / 卸载时销毁终端，释放所有监听与定时器。 */
  unmount(): void {
    this.disposed = true;
    if (this.writeTimer != null) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    if (this.resizeTimer != null) clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    this.writeBuffer = '';
    this.offScroll?.();
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
    this.host = null;
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

  /** 点击置底按钮：滚动到最新（对齐原 jump-bottom onClick）。 */
  scrollToBottom(): void {
    this.term?.scrollToBottom();
  }

  /** 窗口/侧边栏 resize 时由壳的 ResizeObserver 调用，走防抖 refit。 */
  scheduleResize(): void {
    if (this.resizeTimer != null) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => this.doResize(false), 100);
  }

  // —— 私有实现 ——

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

  /** 窗口/侧边栏 resize 时由壳的 ResizeObserver 调用（壳侧已做 100ms 防抖）。
   * 对齐 VS Code：每个 render frame 都 fit，不冻结——冻结会让 PTY 列宽与 TUI 实际高度脱节，
   * 正是流式输出时内容区“多几行/少几行”错位（编辑器上下跳）的来源。 */
  private doResize(force = false): void {
    const term = this.term;
    const fit = this.fit;
    if (!term || !fit || !this.host) return;
    try {
      fit.fit();
    } catch {
      /* fit 失败（尺寸为 0 等边界）时跳过 */
    }
    const { cols, rows } = term;
    if (!force && (this as any)._lastDims) {
      const last = (this as any)._lastDims;
      if (last.cols === cols && last.rows === rows) return;
    }
    (this as any)._lastDims = { cols, rows };
    this.pi.resize(this.sessionKey, cols, rows);
  }

  /** 收到 PTY 数据：对齐 VS Code TerminalDataBufferer，用 5ms 固定时间窗聚合到达的数据块，
   * 窗口结束一次性 term.write，避免流式高频重绘产生的中间帧闪烁。
   * xterm 原生支持 ?2026 同步输出序列（DEC 同步输出），会自行合并未闭合的同步帧再呈现，
   * 故不再需要此前自研的同步帧切分 / hasOpenSyncFrame / 兜底 setTimeout 逻辑。 */
  private handleData(key: string, data: string): void {
    if (key !== this.sessionKey || !this.term) return;
    this.writeBuffer += data;
    if (this.writeTimer != null) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      if (this.disposed || !this.term) return;
      const buf = this.writeBuffer;
      this.writeBuffer = '';
      try {
        this.term.write(buf);
      } catch {
        /* 终端已销毁等边界 */
      }
    }, WRITE_DEBOUNCE_MS);
  }

  /**
   * 绑定滚动探测，驱动置底按钮可见性。
   *
   * 关键修复：xterm 6.0.0 的 **WebGL 渲染器**下，文本画在 <canvas> 上，
   * `.xterm-viewport` 的 scrollHeight 始终等于 clientHeight（不随缓冲区增长），
   * 原生 scrollTop 也恒为 0——故用原生 scrollTop/scrollHeight 判断“未贴底”在 WebGL 下
   * 永远失效（按钮永不出现）。改用 xterm 渲染器无关的 buffer API：
   *   term.buffer.active.viewportY —— 当前视口顶行（ydisp）
   *   term.buffer.active.baseY    —— 缓冲区底行对应的 ydisp
   * 当 viewportY < baseY 即视口未贴底。订阅 term.onScroll（缓冲区滚动时触发）实时更新；
   * 同时保留原生 scroll 事件作 DOM 渲染器兜底（DOM 模式下 scrollHeight 会真实增长）。
   */
  private bindScroll(host: HTMLElement): void {
    const viewport = this.term?.element?.querySelector('.xterm-viewport') as HTMLElement | null;
    const updateFromBuffer = () => {
      const term = this.term;
      if (!term) return;
      // buffer 在 open 后才有；open 失败时跳过。
      const buf = (term as any).buffer?.active;
      if (!buf) return;
      const atBottom = buf.viewportY >= buf.baseY - 1;
      this.showJumpCb?.(!atBottom);
    };
    const onScrollEvt = () => {
      const el = viewport ?? host ?? null;
      if (!el) return;
      const atBottom = el.scrollTop >= el.scrollHeight - el.clientHeight - 2;
      this.showJumpCb?.(!atBottom);
    };
    // 渲染器无关的主路径：缓冲区滚动（含滚轮上滚、流式输出贴底变化）均触发。
    // xterm 的 onScroll 返回 IDisposable，包装成 disposer 便于 unmount 统一清理。
    const termForScroll = this.term!;
    const scrollDisp = termForScroll.onScroll?.(updateFromBuffer);
    this.offScroll = scrollDisp ? () => scrollDisp.dispose() : null;
    // DOM 渲染器兜底：原生 scroll 事件（WebGL 下 scrollHeight 不增长，此分支实际不触发未贴底）。
    viewport?.addEventListener('scroll', onScrollEvt);
    host.addEventListener('scroll', onScrollEvt);
    updateFromBuffer();
  }
}
