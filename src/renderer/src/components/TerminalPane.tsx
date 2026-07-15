import { useEffect, useRef, useState, useCallback, type MouseEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
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
    const term = new Terminal({ convertEol: true, cursorBlink: true, fontFamily: FONT_MONO, fontSize: 13, lineHeight: 1.2, scrollback: 5000, theme: TERM_THEMES[getTheme()] });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term; fitRef.current = fit;

    const onData = (key: string, data: string) => { if (key === sessionKey) term.write(data); };
    pi.onData(onData);

    term.onData((d) => pi.input(sessionKey, d));

    return () => {
      term.dispose();
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
    try { fitRef.current.fit(); } catch {}
    const { cols, rows } = termRef.current;
    pi.resize(sessionKey, cols, rows);

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
  }, [active, sessionKey]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      if (!active || !openedRef.current || !termRef.current || !fitRef.current) return;
      try { fitRef.current.fit(); } catch {}
      const { cols, rows } = termRef.current;
      pi.resize(sessionKey, cols, rows);
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [active, sessionKey]);

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
