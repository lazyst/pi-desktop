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
import { getTheme, onThemeChange, TERM_THEMES } from '../theme';
import { TerminalDataBufferer } from './terminalDataBufferer';
import { TerminalResizeDebouncer } from './terminalResizeDebouncer';
import { DecorationAddon } from './decorationAddon';
import { MarkNavigationAddon } from './markNavigationAddon';
import type { PiApi } from '../ipc';
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

// 平滑滚动时长：对齐 VS Code RenderConstants.SmoothScrollDuration(125ms)。仅物理滚轮/触控板
// 滚动事件时由 xterm 内部启用平滑动画；全屏 TUI 无手动滚动交互，常态不触发，不对写入造成拖影。
const SMOOTH_SCROLL_DURATION = 125;

export interface XtermTerminalOptions {
  sessionKey: string;
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
export class XtermTerminal {
  private readonly sessionKey: string;
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

  // —— 写完成确认（对齐 VS Code _flushXtermData 的「已写入=已解析」闸门）——
  private _latestWriteSeq = 0;
  private _latestParsedSeq = 0;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;

  // —— 反注册函数 ——
  private offStatus: (() => void) | null = null;
  private offTheme: (() => void) | null = null;
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
      // 切回可见：flush 待执行 resize + 立即 resize（对齐 VS Code setVisible）。
      this.resizeDebouncer?.flush();
      this.doResize(true);
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
    this.offStatus?.();
    this.offTheme?.();
    this.offStatus = this.offTheme = null;
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
      // 仅当拖的是文件时才接管（types 含 'Files'）；文本/内部拖拽放行给 xterm。
      if (Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files ?? []);
      if (!files.length) return;
      this.pasteDroppedFiles(files).catch(() => {});
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
      if (!mod) return true;
      const key = e.key.toLowerCase();
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
      // 平滑滚动时长：对齐 VS Code RenderConstants.SmoothScrollDuration(125ms)。仅在有滚轮/
      // 触摸板滚动事件时由 xterm 内部启用平滑动画；全屏 TUI 无手动滚动交互，常态不触发，
      // 不对写入造成拖影。
      smoothScrollDuration: SMOOTH_SCROLL_DURATION,
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
      this.pi.input(this.sessionKey, d);
    });

    // 输出：主进程 pty 数据 → TerminalDataBufferer（5ms 时间窗聚合）→ handleProcessData。
    this.dataBufferer = new TerminalDataBufferer((id, data) => this.handleProcessData(id, data));
    this.stopBuffering = this.dataBufferer.startBuffering(
      this.sessionKey,
      (handler) => this.pi.onData((key, data) => handler(key, data)),
      WRITE_DEBOUNCE_MS,
    );

    this.offStatus = this.pi.onStatus((key, status) => {
      if (key !== this.sessionKey) return;
      if (status === 'dead') this.doResize(true); // 会话结束时收尾 resize，对齐视口
    });
    this.offTheme = onThemeChange((t) => {
      if (this.term) this.term.options.theme = TERM_THEMES[t];
      // 主题切换清纹理图集，避免 WebGL 下旧配色/旧字形纹理残留闪留（对齐 VS Code forceRedraw）。
      this.forceRedraw();
    });

    // 物理滚轮/触控板分类器：仅物理滚轮启用平滑滚动（对齐 VS Code MouseWheelClassifier）。
    this.bindWheelClassifier();

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

  /** 物理滚轮 vs 触控板判定（精简自 VS Code MouseWheelClassifier）。
   * 物理滚轮 deltaX 恒为 0 且 deltaY 为离散整数倍（±刻度）；触控板两轴皆有连续小数。
   * 仅当物理滚轮时启用 smoothScrollDuration，触控板滚动禁用平滑（否则轻滚拖影）。
   * 判定结果经此动态写入 term.options.smoothScrollDuration（基础时长 125ms 对齐 VS Code）。 */
  private bindWheelClassifier(): void {
    const term = this.term;
    if (!term) return;
    const el = (term as any).element as HTMLElement | undefined;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (this.disposed || !this.term) return;
      const isPhysical = e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 1;
      const enabled = isPhysical;
      this.term.options.smoothScrollDuration = enabled ? SMOOTH_SCROLL_DURATION : 0;
    };
    el.addEventListener('wheel', onWheel, { passive: true });
  }

  /** 收到 5ms 聚合后的 PTY 数据（对齐 VS Code TerminalInstance._onProcessData）：
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

  /** 按 shell integration 的 OSC 633 序列切分输入为语义段（对齐 VS Code _onProcessData）。
   * 匹配 \x1b]633;C / \x1b]633;D / \x1b]633;D;n 等命令开始/结束标记，在标记边界把数据切成多段，
   * 使命令级输出可被差分写入。无 OSC 633 序列时原样返回单段（零开销）。 */
  private _segmentByShellIntegration(data: string): string[] {
    const re = /\x1b\]633;(?:C|D(?:;\d+)?)\x07/g;
    const segments: string[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(data)) !== null) {
      if (m.index > last) segments.push(data.slice(last, m.index));
      segments.push(m[0]);
      last = m.index + m[0].length;
    }
    if (last < data.length) segments.push(data.slice(last));
    return segments.length ? segments : [data];
  }

  /** 写入一段数据并回传背压（对齐 VS Code TerminalInstance._writeProcessData）。
   * 单一 term.write（无行切片/rAF 逐批 hack），回调里推进解析序号 + acknowledgeDataEvent。 */
  private _writeProcessData(data: string): void {
    if (this.disposed || !this.term) return;
    const term = this.term;
    const seq = ++this._latestWriteSeq;
    try {
      term.write(data, () => {
        this._latestParsedSeq = Math.max(this._latestParsedSeq, seq);
        // 背压回传（对齐 VS Code _writeProcessData 回调里的 acknowledgeDataEvent）：
        // 通知主进程已消费本段字节，使其对 PTY 做流控，避免高速输出淹没前端缓冲。
        this.pi.acknowledgeDataEvent?.(this.sessionKey, data.length);
      });
    } catch {
      /* 终端已销毁等边界 */
    }
  }

  /** resize 回调：X/Y 同时变化（立即/小 buffer 路径，对齐 VS Code _resizeBothCallback）。 */
  private _resizeBoth(cols: number, rows: number): void {
    if (this.disposed || !this.fit || !this.term) return;
    try {
      this.fit.fit();
    } catch {
      /* fit 失败（尺寸为 0 等边界）时跳过 */
    }
    this._notifyPtyIfChanged();
  }

  /** resize 回调：仅 X（列宽）变化（防抖路径，对齐 VS Code _resizeXCallback）。 */
  private _resizeX(cols: number): void {
    if (this.disposed || !this.fit || !this.term) return;
    try {
      this.fit.fit();
    } catch {
      /* fit 失败边界 */
    }
    this._notifyPtyIfChanged();
  }

  /** resize 回调：仅 Y（行数）变化（即时路径，对齐 VS Code _resizeYCallback）。 */
  private _resizeY(rows: number): void {
    if (this.disposed || !this.term) return;
    if (rows !== this.term.rows) {
      try {
        this.term.resize(this.term.cols, rows);
      } catch {
        /* resize 边界 */
      }
    }
    this._notifyPtyIfChanged();
  }

  /** 仅在 cols/rows 真变时才通知 PTY（对齐 VS Code 整数 dims 比较，避免无谓 resize）。 */
  private _notifyPtyIfChanged(): void {
    if (!this.term) return;
    const { cols, rows } = this.term;
    if (cols === this._lastCols && rows === this._lastRows) return;
    this._lastCols = cols;
    this._lastRows = rows;
    this.pi.resize(this.sessionKey, cols, rows);
  }

  /** 立即用宿主最新尺寸校准终端并通知 PTY（首挂载 / 切回可见 / 会话结束收尾调用，force=true）。
   * 对齐 VS Code TerminalInstance.setVisible 的 _resize（open 后用真实容器尺寸重测）。
   * 实际的分轴防抖 / 可见性 / idle 调度全部交给 TerminalResizeDebouncer 处理。 */
  private doResize(force = false): void {
    if (this.disposed || !this.fit || !this.term || !this.host) return;
    const proposed = this.fit.proposeDimensions();
    if (!proposed) return;
    const smallBuffer = force || this._isSmallBuffer();
    this.resizeDebouncer?.resize(proposed.cols, proposed.rows, force, smallBuffer);
  }
}
