import { useEffect, useRef, useState, useCallback, type MouseEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
// GPU 渲染器：参照 VS Code 的 XtermTerminal._enableWebglRenderer。xterm 6.0.0 内建的是 DOM 渲染器，
// 流式高频重绘（pi-tui 每 token 重绘编辑器面板）时会在「清空行 → 重写行」之间露出中间帧，
// 表现为闪烁。WebGL 把整屏合成交给显卡一次完成，无中间帧，从根本上消除该闪烁。
// 各渲染器 addon 必须与 @xterm/xterm 主版本严格配套：本工程使用 xterm 6.0.0，其官方配套为
// addon-webgl 0.19.0（6.0.0 已移除 canvas 渲染器，故仅 WebGL→内建 DOM 两级回退）。混用错误
// 主版本（如 5.5.0 配 addon-webgl 0.19.0）会因子渲染器内部 API 不兼容而崩溃、整屏黑。
import { WebglAddon } from '@xterm/addon-webgl';
import { pi } from '../ipc';
import { getTheme, onThemeChange, TERM_THEMES } from '../theme';
import { IconArrowDown } from './icons';
import '@xterm/xterm/css/xterm.css';

// Mirrors --font-mono in tokens.css. xterm reads a literal font-family string,
// not a CSS variable, so we repeat the stack here (kept in sync with tokens.css).
const FONT_MONO = "'JetBrains Mono','Fira Code','Cascadia Code',ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

interface Props { sessionKey: string; active: boolean; }

export function TerminalPane({ sessionKey, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal>();
  const fitRef = useRef<FitAddon>();
  const openedRef = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const lastDims = useRef<{ cols: number; rows: number } | null>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 最近一次收到 PTY 数据的时间戳。用于判断“是否正处于流式输出窗口”，
  // 与具体程序无关（pi / htop / neovim / 任何 PTY 程序都适用）。
  const lastDataAt = useRef(0);
  // 停止收数据多少毫秒后，才允许 refit（解冻）。流式输出时窗口/侧边栏被拖动本就罕见，
  // 但更重要的是：若流式期间一直 freeze resize，PTY 的 cols/rows 与真实视口会渐趋不一致，
  // TUI 程序（如 pi-tui）下一帧会误判尺寸变化 → 整屏 fullRender(true) 重绘 → 自动贴底 reset → 上下跳动。
  // 改成“安静后才 refit”，既避免流式高频 resize 抖动，又保证空闲时尺寸始终正确。
  const RESIZE_QUIET_MS = 120;
  // 渲染器仅尝试加载一次：成功则后续复用；失败则回退到内建 DOM 渲染器，不再重试。
  // WebGL 上下文丢失自愈：允许有限次重试，让瞬时 GPU 重置/驱动恢复后自动回到 GPU 渲染器，
  // 而非永久掉回 DOM（否则流式会重新闪烁）。MAX 上限避免 GPU 真坏时无限重试。
  const MAX_WEBGL_RETRIES = 3;
  const webglEnabledRef = useRef(false);   // 本实例是否已启用 WebGL（避免 StrictMode 双调用重复 loadAddon）
  const webglAttemptsRef = useRef(0);      // 已尝试次数（含上下文丢失后的重试）
  const webglRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enableWebglRef = useRef<() => void>(() => {});

  // 流式输出（正在收数据）窗口内冻结终端尺寸：最近一次收数据后 RESIZE_QUIET_MS 内不 refit，
  // 避免每帧 resize 触发 TUI 重折行/整屏重绘导致跳动。停止收数据超过该窗口后自动解冻，
  // 窗口/侧边栏 resize 即可正常重算（对应 VS Code/iTerm 等“数据来时不动布局、安静时才 refit”的通用行为）。
  // 不依赖任何具体程序状态，对所有 PTY 程序通用。
  const doResize = useCallback((force = false) => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit || !hostRef.current) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (!force && now - lastDataAt.current < RESIZE_QUIET_MS) return;
    try { fit.fit(); } catch {}
    const { cols, rows } = term;
    const last = lastDims.current;
    if (!force && last && last.cols === cols && last.rows === rows) return;
    lastDims.current = { cols, rows };
    pi.resize(sessionKey, cols, rows);
  }, [sessionKey]);

  const debouncedResize = useCallback(() => {
    if (resizeTimer.current) clearTimeout(resizeTimer.current);
    resizeTimer.current = setTimeout(() => doResize(false), 100);
  }, [doResize]);

  // 启用 WebGL(GPU) 渲染器，失败回退 DOM。必须在 term.open() 之后调用（WebGL 需要已挂载的元素）。
  // xterm 6.0.0 移除 canvas 渲染器后，仅剩 WebGL 与内建 DOM 两档：WebGL 整屏一次合成，
  // 从根本上消除流式闪烁（VS Code 同款）；无 WebGL（禁用 GPU）时静默回退 DOM，与 VS Code 一致。
  // WebGL 单元度量与 DOM 略有差异，加载成功后按当前容器重算尺寸，避免首帧错位
  // （对应 VS Code 加载 WebGL 后触发一次 refit）；上下文丢失（如 GPU 进程崩溃/驱动重置）时
  // 丢弃 addon，xterm 自动回退内建 DOM 渲染器，避免黑屏/卡死（对应 VS Code 的 onContextLoss 回退）。
  const enableWebgl = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    if (webglEnabledRef.current) return; // 本实例已启用，避免 StrictMode 双调用/重复 loadAddon
    if (webglAttemptsRef.current >= MAX_WEBGL_RETRIES) return;
    webglAttemptsRef.current += 1;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        // 上下文丢失（GPU 进程崩溃/驱动重置）会掉回 DOM 渲染器；冷却后自动重试启用 WebGL，
        // 让瞬时故障自愈，而非永久停留在 DOM（否则流式会重新闪烁）。
        webglEnabledRef.current = false; // 允许冷却后重试再次 loadAddon
        console.warn('[terminal] WebGL 上下文丢失，回退 DOM 渲染器（冷却后将自动重试启用）');
        try { addon.dispose(); } catch { /* 回退 DOM 渲染器 */ }
        if (webglAttemptsRef.current < MAX_WEBGL_RETRIES) {
          webglRetryTimer.current = setTimeout(() => enableWebglRef.current(), 1000);
        }
      });
      term.loadAddon(addon);
      webglEnabledRef.current = true;
      doResize(true);
      // 明确确认 GPU 渲染器已生效（打开 DevTools Console 即可看到，便于核实无闪烁修复）。
      console.info('[terminal] WebGL 渲染器已启用（流式高频重绘无闪烁）。');
    } catch (e) {
      // WebGL 不可用（典型：环境无硬件 GPU 且未启用 SwiftShader 软件回退）时静默回退
      // 到内建 DOM 渲染器。给出明确告警，便于确诊：流式输出闪烁即源于此。
      console.warn(
        '[terminal] WebGL 渲染器启用失败，已回退到 DOM 渲染器（流式高频重绘可能闪烁）。\n' +
        '若环境无硬件 GPU，请确认主进程已设置 --enable-unsafe-swiftshader 以启用软件 WebGL。',
        e,
      );
    }
  }, [doResize]);
  enableWebglRef.current = enableWebgl;

  const handleContextMenu = useCallback((e: MouseEvent) => {
    e.preventDefault();
    const term = termRef.current;
    if (!term) return;
    try {
      const clip = navigator.clipboard;
      if (!clip) return;
      if (term.hasSelection()) {
        clip.writeText(term.getSelection()).catch(() => {});
        term.clearSelection(); // 复制后清空选区，给用户“已复制”的视觉反馈
      } else {
        clip.readText().then((text) => { if (text) term.paste(text); }).catch(() => {});
      }
    } catch { /* 剪贴板不可用（如非安全上下文）时静默跳过 */ }
  }, []);

  useEffect(() => {
    // xterm lineHeight is a multiplier (default 1.0); 1.2 is a comfortable
    // spacing that honors the spec's intent without over-loose rows.
    // theme 来自与 DOM 同一套 GitHub 调色板（TERM_THEMES），构造即按当前主题上色，
    // 避免首屏白/暗闪；运行期切换经下方 onThemeChange 订阅实时重绘。
    const term = new Terminal({
      allowProposedApi: true, // 启用提案 API（pi-tui 使用同步输出 ?2026 APM 序列所需）
      // 注意：不开启 convertEol。PTY 已输出标准 \r\n，convertEol 会把裸 \n 也转 \r\n，
      // 在 pi-tui 差分渲染里偶尔多出回车字节，导致行错位/重排式闪烁。VS Code 终端同样不对 PTY 数据开 convertEol。
      cursorBlink: true,
      // 以下选项对齐 VS Code 的终端渲染配置（VS Code 用同一套公开 xterm 核心，
      // 行为差异主要来自它的 XtermTerminal 封装选项），以消除与 VS Code 终端的差异。
      cursorStyle: 'bar',
      // minimumContrastRatio 对齐 VS Code（默认 4.5，按 WCAG 调整单元格前景对比度）。
      // 此前误以为它造成“色跳”而关为 1，但 VS Code 开着并不跳——排除此变量，恢复默认。
      minimumContrastRatio: 4.5,
      drawBoldTextInBrightColors: true,
      letterSpacing: 0,
      tabStopWidth: 8,
      // 对齐 VS Code 的 scrollOnEraseInDisplay: true。Erase in Display(ED2, \x1b[2J) 时把被擦除的
      // 文本推入 scrollback 而非只清视口，避免 pi-tui 每帧 fullRender(true) 清屏时视口跳动/内容错位。
      scrollOnEraseInDisplay: true,
      fontFamily: FONT_MONO,
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: TERM_THEMES[getTheme()],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term; fitRef.current = fit;

    term.onData((d) => pi.input(sessionKey, d));

    // 合并 pty 输出，消除流式高频重绘闪烁：
    // 对齐 VS Code 集成终端的 TerminalDataBufferer 做法——用固定时间窗（5ms）累积到达的数据块，
    // 窗口结束后一次性 term.write 整段。VS Code 不解析 ?2026、不做帧切分，完全信任 xterm 的
    // synchronizedOutput 状态机（?2026h/?2026l 跨多次 write 也能正确缓冲到帧末再合成）。
    // 此前我自作的「按 ?2026l 严格切分」会把连续流拆得更碎、人为增加延迟，反而制造跳动——已回退。
    let disposed = false;
    const pending: string[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    // 时间窗长度，对齐 VS Code 的 throttleBy=5。窗口内到达的多个数据块合并成一次 write。
    const FLUSH_MS = 5;
    // 流式活跃时临时关闭光标闪烁的配套：流式停止多久后恢复 cursorBlink（避免输出间隙误关/频繁切换）。
    const BLINK_RESTORE_MS = 400;
    let blinkRestoreTimer: ReturnType<typeof setTimeout> | null = null;
    let blinkSuppressed = false; // 当前是否已因流式而关闭 cursorBlink
    const flush = () => {
      if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
      if (disposed || pending.length === 0) { pending.length = 0; return; }
      const data = pending.join('');
      pending.length = 0;
      try { term.write(data); } catch { /* 终端已销毁等边界 */ }
      // 注意：此处不调用 term.scrollToBottom()。xterm 对 ?2026 同步输出帧有自己的整帧渲染与
      // 自动跟随，手动钉底会形成“贴底→scroll 事件→再贴底”的正反馈闭环，导致用户无法向上滚动查看历史。
      // 流式跟随交给 xterm 原生自动跟随即可；用户向上滚动时 xterm 会自动停止跟随，保留浏览位置。
    };
    // 流式活跃时关闭光标闪烁：xterm 的自动跟随在每帧把视口钉底（ydisp=ybase），而 TUI 用差分渲染把
    // cursor 在「底部输入框」与「上方编辑器重绘行」间逐帧移动，叠加 cursorBlink 的亮灭就会产生
    // “光标在行间上下闪”的观感（仅贴底跟随时明显，上滚浏览时不闪——此时 isUserScrolling=true 不跟随）。
    // 关闭 blink 后 cursor 为稳定实心块随输出移动，闪烁感消失。与具体程序无关（任何逐帧移动 cursor 的
    // TUI 都受益）。输出停止 BLINK_RESTORE_MS 后恢复闪烁，不影响空闲/交互时的光标体验。
    const suppressBlinkWhileStreaming = () => {
      if (blinkSuppressed) return;
      blinkSuppressed = true;
      try { term.options.cursorBlink = false; } catch { /* 已销毁等边界 */ }
      if (blinkRestoreTimer != null) clearTimeout(blinkRestoreTimer);
      blinkRestoreTimer = setTimeout(() => {
        blinkRestoreTimer = null;
        if (disposed) return;
        blinkSuppressed = false;
        try { term.options.cursorBlink = true; } catch { /* 已销毁等边界 */ }
      }, BLINK_RESTORE_MS);
    };
    const onData = (key: string, data: string) => {
      if (key !== sessionKey) return;
      // 记录最近收数据时间，供 doResize 的“流式窗口内冻结”判断使用（与合并逻辑互不耦合，对所有程序通用）。
      lastDataAt.current = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      suppressBlinkWhileStreaming();
      pending.push(data);
      // 首包立即起一个时间窗定时器；窗口内后续数据只累积不重复起定时器，窗口结束一次性写出。
      // 连续流时每个窗口（5ms）自然合并多帧，xterm 的 ?2026 状态机保证整帧原子合成、无中间帧闪烁。
      if (flushTimer == null) flushTimer = setTimeout(flush, FLUSH_MS);
    };
    // preload 的 onData 返回反注册函数；务必在卸载时调用，避免 handler 泄漏。
    const offData = pi.onData(onData);

    return () => {
      disposed = true;
      if (flushTimer != null) clearTimeout(flushTimer);
      if (blinkRestoreTimer != null) clearTimeout(blinkRestoreTimer);
      if (webglRetryTimer.current != null) clearTimeout(webglRetryTimer.current);
      if (typeof offData === 'function') offData();
      try { term.dispose(); } catch { /* 已销毁 */ }
      openedRef.current = false;
    };
  }, [sessionKey]);

  // 跟随应用主题：订阅 onThemeChange，切换时实时重绘所有已打开终端（xterm 支持运行时改 theme）。
  useEffect(() => {
    return onThemeChange((t) => {
      const term = termRef.current;
      if (term) term.options.theme = TERM_THEMES[t];
    });
  }, []);

  useEffect(() => {
    if (!active || !hostRef.current || !termRef.current || !fitRef.current) return;
    try {
      if (!openedRef.current) { termRef.current.open(hostRef.current); openedRef.current = true; }
    } catch { /* jsdom/headless: ignore open failures */ }
    enableWebgl();
    doResize(true);

    // 需求 5：未贴底时显示置底按钮。
    // 优先监听真实 xterm viewport 的原生 scroll（浏览器精确）；
    // jsdom 下 xterm 不会创建 .xterm-viewport，故同时挂到 hostRef 作为兜底
    // （真实浏览器中 host 不滚动，该兜底是无害的死重）。
    const viewport = termRef.current.element?.querySelector('.xterm-viewport') as HTMLElement | null;
    const host = hostRef.current;
    const onScrollEvt = () => {
      const el = viewport ?? host ?? null;
      if (!el) return;
      const atBottom = el.scrollTop >= el.scrollHeight - el.clientHeight - 2;
      setShowJump(!atBottom);
    };
    viewport?.addEventListener('scroll', onScrollEvt);
    host?.addEventListener('scroll', onScrollEvt);
    onScrollEvt();
    return () => {
      viewport?.removeEventListener('scroll', onScrollEvt);
      host?.removeEventListener('scroll', onScrollEvt);
    };
  }, [active, sessionKey, doResize, enableWebgl]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => debouncedResize());
    ro.observe(host);
    return () => ro.disconnect();
  }, [active, sessionKey]);

  // 会话结束时（进程退出 dead）做一次收尾 resize，让布局收尾对齐当前视口。
  // 注意：不再用进程级 running 状态控制“冻结”——running 在会话创建时只触发一次，
  // 会导致整个会话都冻结 resize，使 PTY cols/rows 与真实视口渐趋不一致、TUI 程序误判尺寸
  // 而整屏重绘跳动。尺寸冻结改由 doResize 内部的“收数据时间窗”判断（见 RESIZE_QUIET_MS），
  // 对所有 PTY 程序通用，与具体程序无关。
  useEffect(() => {
    const off = pi.onStatus((key: string, status: string) => {
      if (key !== sessionKey) return;
      if (status === 'dead') {
        doResize(true);
      }
    });
    return off;
  }, [sessionKey, doResize]);

  return (
    <>
      <div ref={hostRef} data-session={sessionKey} className={active ? 'terminal-host active' : 'terminal-host'} onContextMenu={handleContextMenu} />
      {active && (
        <button
          className={`jump-bottom${showJump ? ' visible' : ''}`}
          title="滚动到最新"
          aria-label="滚动到最新"
          onClick={() => termRef.current?.scrollToBottom()}
        >
          <IconArrowDown />
        </button>
      )}
    </>
  );
}
