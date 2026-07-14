import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { pi } from '../ipc';
import '@xterm/xterm/css/xterm.css';

interface Props { sessionKey: string; active: boolean; }

export function TerminalPane({ sessionKey, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal>();
  const fitRef = useRef<FitAddon>();

  useEffect(() => {
    const term = new Terminal({ convertEol: true, cursorBlink: true, fontFamily: 'monospace', fontSize: 13 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term; fitRef.current = fit;

    const onData = (key: string, data: string) => { if (key === sessionKey) term.write(data); };
    pi.onData(onData);

    term.onData((d) => pi.input(sessionKey, d));

    const host = hostRef.current;
    if (host) {
      term.open(host);
      try { fit.fit(); } catch {}
      const { cols, rows } = term;
      pi.resize(sessionKey, cols, rows);
    }

    return () => {
      term.dispose();
      // Note: pi.onData has no off(); a production build should track and ignore stale keys.
    };
  }, [sessionKey]);

  useEffect(() => {
    // Only (re)fit while the pane is actually visible. Fitting a hidden (display:none)
    // element yields a 0×0 size and would resize the PTY to 0×0, dropping buffered
    // output — which breaks session-continuity checks. The terminal is opened once on
    // mount; here we just keep it sized correctly when it becomes active again.
    if (!active || !termRef.current || !fitRef.current) return;
    try { fitRef.current.fit(); } catch {}
    const { cols, rows } = termRef.current;
    pi.resize(sessionKey, cols, rows);
  }, [active, sessionKey]);

  return <div ref={hostRef} data-session={sessionKey} className={active ? 'terminal-host active' : 'terminal-host'} style={{ flex: 1, padding: 8, background: '#0c0c0c', display: active ? 'block' : 'none' }} />;
}
