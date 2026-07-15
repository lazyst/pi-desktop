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

// 诊断开关：dev 模式（pnpm dev）下自动开启，生产构建自动关闭；
// 也可用 VITE_TERM_DEBUG=1 显式开启（含生产构建）。开启后流式期间每秒打印一次
// 本次 flush 合并了几块 pty 输出，用于确认 pi-tui 差分渲染的块分布、微调合并窗口。
// 注：不依赖自定义 VITE_* 从 shell 注入渲染进程（electron-vite 下不可靠），改用 Vite 必注入的 DEV。
const TERM_DEBUG = (import.meta as any).env?.DEV === true || (import.meta as any).env?.VITE_TERM_DEBUG === '1';

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
  const streaming = useRef(false);
  // 渲染器仅尝试加载一次：成功则后续复用；失败则回退到内建 DOM 渲染器，不再重试。
  // WebGL 上下文丢失自愈：允许有限次重试，让瞬时 GPU 重置/驱动恢复后自动回到 GPU 渲染器，
  // 而非永久掉回 DOM（否则流式会重新闪烁）。MAX 上限避免 GPU 真坏时无限重试。
  const MAX_WEBGL_RETRIES = 3;
  const webglEnabledRef = useRef(false);   // 本实例是否已启用 WebGL（避免 StrictMode 双调用重复 loadAddon）
  const webglAttemptsRef = useRef(0);      // 已尝试次数（含上下文丢失后的重试）
  const webglRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enableWebglRef = useRef<() => void>(() => {});

  // 流式期间冻结终端尺寸：只在尺寸真正变化（≥1）时才 resize，并去抖。
  // 否则每帧的 resize 会让 pi-tui 重新折行、编辑器高频跳动。
  // VS Code 的终端尺寸由系统稳定管理，所以不跳；这里用冻结+去抖对齐其行为。
  const doResize = useCallback((force = false) => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit || !hostRef.current) return;
    if (streaming.current && !force) return;
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
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: true,
      // 以下选项对齐 VS Code 的终端渲染配置（VS Code 用同一套公开 xterm 核心，
      // 行为差异主要来自它的 XtermTerminal 封装选项），以消除与 VS Code 终端的差异。
      cursorStyle: 'bar',
      minimumContrastRatio: 4.5, // VS Code 默认：按 WCAG 调整单元格前景对比度
      drawBoldTextInBrightColors: true,
      letterSpacing: 0,
      tabStopWidth: 8,
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
    // pi-tui 每 token 重绘「清屏→重绘」时，clear 与 redraw 往往落在同一动画帧（~16ms）内。
    // 若被拆成两次 term.write 且跨了渲染帧，xterm 会先画出「空屏」一帧再画内容，表现为闪烁。
    // 这里把同一帧内到达的多个数据块合并成一次 term.write，由 xterm 一次性合成渲染，消除中间帧。
    // （VS Code 的终端数据路径更紧凑、天然同帧到达，故不闪；此处主动对齐其行为。）
    let disposed = false;
    const pending: string[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let flushStart = 0;
    // 合并 pty 输出，消除 pi-tui 差分渲染的闪烁：
    // pi-tui 每帧只写变化的格子（光标移动+局部文本），这些小写经 IPC 成为多个数据块先后到达。
    // 若一帧的差分被拆成两次 term.write 且跨了 xterm 渲染帧，会先画出「半截差分」一帧再补齐 → 闪烁。
    // 尾沿去抖：收到数据后等 COALESCE_MS 的安静期再一次性 flush，把一整个 TUI 帧的差分合并为原子
    // term.write；连续流最多 MAX_WAIT_MS 强制刷新一次，避免无限缓冲。（对齐 VS Code 的整帧写入语义。）
    const COALESCE_MS = 16;
    const MAX_WAIT_MS = 50;
    let lastDebugLog = 0;
    const flush = () => {
      if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
      if (disposed || pending.length === 0) { pending.length = 0; return; }
      const chunks = pending.length;
      const data = pending.join('');
      pending.length = 0;
      if (TERM_DEBUG) {
        const t = Date.now();
        if (t - lastDebugLog >= 1000) {
          lastDebugLog = t;
          console.debug(`[terminal:debug] 本次 flush 合并 ${chunks} 块 pty 输出${chunks > 1 ? '' : '（单块，无需合并）'}`);
        }
      }
      try { term.write(data); } catch { /* 终端已销毁等边界 */ }
    };
    const onData = (key: string, data: string) => {
      if (key !== sessionKey) return;
      pending.push(data);
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (flushTimer == null) {
        flushStart = now;
        flushTimer = setTimeout(flush, COALESCE_MS);
      } else if (now - flushStart >= MAX_WAIT_MS) {
        flush(); // 连续流：强制刷新，下一包数据重新计时
      } else {
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flush, COALESCE_MS);
      }
    };
    // preload 的 onData 返回反注册函数；务必在卸载时调用，避免 handler 泄漏。
    const offData = pi.onData(onData);

    return () => {
      disposed = true;
      if (flushTimer != null) clearTimeout(flushTimer);
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

  // 流式（running）期间冻结尺寸，避免每帧 resize 触发 pi-tui 重折行导致跳动；
  // 输出结束时再 resize 一次让布局收尾（对应 VS Code 结束时的那一次跳）。
  useEffect(() => {
    const off = pi.onStatus((key: string, status: string) => {
      if (key !== sessionKey) return;
      const running = status === "running";
      if (running && !streaming.current) {
        streaming.current = true;
      } else if (!running && streaming.current) {
        streaming.current = false;
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
