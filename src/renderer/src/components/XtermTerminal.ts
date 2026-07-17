// XtermTerminal —— VS Code 风格的终端薄封装（见 docs/adr/0002）。
//
// 这是本次重构的核心：把原 TerminalPane.tsx 内全部 xterm 渲染逻辑（WebGL 渲染器锁定、
// FitAddon 度量、CJK 等宽字体栈、5ms 数据合并缓冲、scroll/置底判定）
// 收编进一个对上层透明的类。TerminalPane 退化为 React 生命周期壳，持有一个本类实例。
//
// 设计对齐 VS Code 集成终端的分层意图（但只取渲染/缓冲/度量这一层，不搬 DI/workbench）：
//   - 渲染器策略对齐 VS Code 的 XtermTerminal._enableWebglRenderer：open 前同步探测 WebGL，
//     open 后整会话恒定、绝不中途切换（S1，度量不跳变的根）。
//   - 数据缓冲对齐 VS Code 的 TerminalDataBufferer：固定 5ms 时间窗累积到达的数据块，
//     窗口结束一次性 term.write，消除流式高频重绘的中间帧闪烁。
//   - 字体栈前置含 CJK 的等宽字体，对齐 VS Code 让 ASCII/CJK 落同一字宽网格，消除混排度量漂移。
//
// 对外契约（B2-a 契约保形）：本类只通过构造传入的 pi 接口收发数据，不触碰主进程 / preload /
// IPC 信道名。PTY 链路零接触（见 docs/adr/0002）。
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { getTheme, onThemeChange, TERM_THEMES } from '../theme';
import type { PiApi } from '../ipc';
import '@xterm/xterm/css/xterm.css';

// 终端专用字体栈：关键在“含 CJK 的等宽字体”。xterm 的 DOM 渲染器用 CharMeasure 实测当前
// 字体墨迹高度来算 cell.height（见 xterm DomRenderer: cell.height = char.height * lineHeight）。
// 若字体栈混入不含 CJK 的 JetBrains Mono，CJK 字符回退到系统字体、墨迹高度与 ASCII 不同→
// CharMeasure 测得的高度漂移→cell.height 变→行盒上下漂（跳动根因之一，见 docs/adr/0002）。
// 故用同一字宽网格承载 ASCII 与 CJK：优先系统等宽中文（Microsoft YaHei Mono / Sarasa），
// 最终兜底 Microsoft YaHei（同一字体的 ASCII 与 CJK 墨迹高度一致，保证 CharMeasure 稳定）。
const FONT_MONO = "'Sarasa Mono SC','Sarasa Mono','Microsoft YaHei Mono','JetBrains Mono','Fira Code','Cascadia Code',ui-monospace,'Microsoft YaHei',monospace";

export interface XtermTerminalOptions {
  sessionKey: string;
  pi: PiApi;
}

/**
 * 单个会话的 xterm 终端封装。生命周期：
 *   new → mount(host)（active 时 open + 锁定渲染器 + 绑 IPC）→ unmount()（dispose）。
 * 对 React 壳完全透明：壳只负责在 active 时调用 mount、非 active 时调用 unmount，
 * 以及把 host div / 右键 / 置底按钮的 DOM 事件转交本类。
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

  // —— 流式窗口内防抖 resize 相关 ——
  private lastDims: { cols: number; rows: number } | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  // —— 数据写队列（对齐 VS Code 的 write(data, cb) 契约：上一帧解析完才写下一帧） ——
  // 不用 setTimeout 缓冲窗口：VS Code 的 TerminalDataBufferer 在 processManager 层做节流，
  // 而 xterm 的 raw.write 自带 callback（解析完成后触发）。这里用队列 + 串行 write 严格对齐，
  // 避免多个帧同时堆进 xterm 写队列、WebGL 在“清行未写”的中间态渲染导致跳动。
  private writeQueue: string[] = [];
  private writeScheduled = false;

  // —— 输出文本镜像（无障碍 + e2e 可观测，见 appendMirror）相关 ——
  // 截断到 MAX_MIRROR 字节挂到 host.dataset.output。xterm 6.0.0 的 WebGL 渲染器把文本画在
  // <canvas> 上、不创建 .xterm-rows DOM 文本层，故 e2e 无法用 .toContainText 断言输出。
  private static readonly MAX_MIRROR = 4096;
  private mirror = '';

  // —— 置底按钮可见性回调（壳订阅）——
  private showJumpCb: ((show: boolean) => void) | null = null;
  private scrollHandler: (() => void) | null = null;
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
   * 在 active 且 host 就绪时挂载终端：构造 xterm、open、锁定渲染器、绑定 IPC。
   * 与 TerminalPane 原 active effect 等价（open 前 enableWebgl，open 后 doResize(true)）。
   */
  mount(host: HTMLElement): void {
    if (this.opened) return;
    this.host = host;

    const term = new Terminal({
      allowProposedApi: true, // 启用提案 API（pi-tui 使用同步输出 ?2026 APM 序列所需）
      // 不开启 convertEol。PTY 已输出标准 \r\n，convertEol 会把裸 \n 也转 \r\n，
      // 在 pi-tui 差分渲染里偶尔多出回车字节，导致行错位/重排式闪烁。VS Code 终端同样不对 PTY 数据开 convertEol。
      cursorBlink: true,
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
      // lineHeight 对齐 VS Code 默认 1.0（VS Code 终端默认行高 1.0；1.2 会让行盒更高，
      // 真实换行滚屏位移更显眼）。
      lineHeight: 1.0,
      scrollback: 5000,
      theme: TERM_THEMES[getTheme()],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    this.term = term;
    this.fit = fit;

    term.onData((d) => this.pi.input(this.sessionKey, d));

    this.offData = this.pi.onData((key, data) => this.handleData(key, data));
    this.offStatus = this.pi.onStatus((key, status) => {
      if (key !== this.sessionKey) return;
      if (status === 'dead') this.doResize(true); // 会话结束时收尾 resize，对齐视口
    });
    this.offTheme = onThemeChange((t) => {
      if (this.term) this.term.options.theme = TERM_THEMES[t];
    });

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
    if (this.resizeTimer != null) clearTimeout(this.resizeTimer);
    this.offScroll?.();
    this.offData?.();
    this.offStatus?.();
    this.offTheme?.();
    this.offData = this.offStatus = this.offTheme = null;
    this.scrollHandler = null;
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

  /** 右键上下文菜单：有选区则复制并清空，否则粘贴（对齐原 handleContextMenu）。 */
  handleContextMenu(e: MouseEvent): void {
    e.preventDefault();
    const term = this.term;
    if (!term) return;
    try {
      const clip = navigator.clipboard;
      if (!clip) return;
      if (term.hasSelection()) {
        clip.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
      } else {
        clip.readText().then((text) => {
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
    const last = this.lastDims;
    if (!force && last && last.cols === cols && last.rows === rows) return;
    this.lastDims = { cols, rows };
    this.pi.resize(this.sessionKey, cols, rows);
  }

  /** 收到 PTY 数据：入写队列并触发写出（对齐 VS Code TerminalDataBufferer + write(data,cb)）。
   * 注意：不动 cursorBlink（VS Code 流式期间不改它，自创的 suppress 会与 pi 的光标显隐序列打架致闪）。 */
  private handleData(key: string, data: string): void {
    if (key !== this.sessionKey || !this.term) return;
    this.writeQueue.push(data);
    if (!this.writeScheduled) {
      this.writeScheduled = true;
      // 下一微任务批量取出并原子写出（对齐 VS Code：窗口内 join 成一次 write，
      // “移光标+写文本”序列在同一帧被解析，避免 WebGL 在中间态渲染）。
      Promise.resolve().then(() => this.drainQueue());
    }
  }

  /** 写出：取当前队列全部数据 join 成一次 write（原子帧），用 callback 驱动下一窗口（对齐 VS Code）。 */
  private drainQueue(): void {
    this.writeScheduled = false;
    if (this.disposed || !this.term || this.writeQueue.length === 0) return;
    // 窗口内 join（对齐 VS Code 的 buffer.data.join('')）：保证“移光标+写文本”原子解析，
    // 消除拆成多个 write 时 WebGL 在中间态渲染导致的行号漂移/闪烁。
    const data = this.writeQueue.join('');
    this.writeQueue = [];
    const term = this.term;
    try {
      term.write(data, () => {
        // 上一窗口解析完成，期间若有新数据则继续下一窗口
        if (this.writeQueue.length > 0 && !this.writeScheduled && !this.disposed) {
          this.writeScheduled = true;
          Promise.resolve().then(() => this.drainQueue());
        }
      });
    } catch {
      /* 终端已销毁等边界 */
    }
    this.appendMirror(data);
  }

  /** 把输出文本累积到镜像缓冲并写入 host.dataset.output（截断到 MAX_MIRROR）。 */
  private appendMirror(data: string): void {
    if (!this.host) return;
    // 去掉 ANSI 控制序列与多余回车，只留可打印文本，避免 data-output 充满 escape 噪音。
    const text = data
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\r\n?/g, '\n');
    this.mirror += text;
    if (this.mirror.length > XtermTerminal.MAX_MIRROR) {
      this.mirror = this.mirror.slice(this.mirror.length - XtermTerminal.MAX_MIRROR);
    }
    this.host.dataset.output = this.mirror;
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
    this.scrollHandler = onScrollEvt;
    // 渲染器无关的主路径：缓冲区滚动（含滚轮上滚、流式输出贴底变化）均触发。
    // xterm 的 onScroll 返回 IDisposable，包装成 disposer 便于 unmount 统一清理。
    const scrollDisp = this.term.onScroll?.(updateFromBuffer);
    this.offScroll = scrollDisp ? () => scrollDisp.dispose() : null;
    // DOM 渲染器兜底：原生 scroll 事件（WebGL 下 scrollHeight 不增长，此分支实际不触发未贴底）。
    viewport?.addEventListener('scroll', onScrollEvt);
    host.addEventListener('scroll', onScrollEvt);
    updateFromBuffer();
  }
}
