import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { pi } from '../ipc';
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

  useEffect(() => {
    // xterm lineHeight is a multiplier (default 1.0); 1.2 is a comfortable
    // spacing that honors the spec's intent without over-loose rows.
    const term = new Terminal({ convertEol: true, cursorBlink: true, fontFamily: FONT_MONO, fontSize: 13, lineHeight: 1.2 });
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

  useEffect(() => {
    if (!active || !hostRef.current || !termRef.current || !fitRef.current) return;
    if (!openedRef.current) {
      termRef.current.open(hostRef.current);
      openedRef.current = true;
    }
    try { fitRef.current.fit(); } catch {}
    const { cols, rows } = termRef.current;
    pi.resize(sessionKey, cols, rows);
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

  return <div ref={hostRef} data-session={sessionKey} className={active ? 'terminal-host active' : 'terminal-host'} />;
}
