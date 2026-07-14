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
  const openedRef = useRef(false);

  useEffect(() => {
    const term = new Terminal({ convertEol: true, cursorBlink: true, fontFamily: 'monospace', fontSize: 13 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term; fitRef.current = fit;

    const onData = (key: string, data: string) => { if (key === sessionKey) term.write(data); };
    pi.onData(onData);

    term.onData((d) => pi.input(sessionKey, d));

    // Create the terminal + wire I/O here. Opening/fitting is deferred to the
    // [active] effect so we never fit a hidden (display:none) element to 0x0,
    // which would resize the PTY to 0x0 and drop buffered output (breaking
    // session-continuity). A newly opened pane is always mounted active, so it
    // opens immediately on first activation.
    return () => {
      term.dispose();
      openedRef.current = false;
      // Note: pi.onData has no off(); a production build should track and ignore stale keys.
    };
  }, [sessionKey]);

  useEffect(() => {
    // Only open/fit/resize while the pane is actually visible. Fitting a hidden
    // element yields a 0x0 size and would resize the PTY to 0x0, dropping buffered
    // output — which breaks session-continuity. The terminal is opened once (when
    // first active); subsequent activations just re-fit and re-resize.
    if (!active || !hostRef.current || !termRef.current || !fitRef.current) return;
    if (!openedRef.current) {
      termRef.current.open(hostRef.current);
      openedRef.current = true;
    }
    try { fitRef.current.fit(); } catch {}
    const { cols, rows } = termRef.current;
    pi.resize(sessionKey, cols, rows);
  }, [active, sessionKey]);

  return <div ref={hostRef} data-session={sessionKey} className={active ? 'terminal-host active' : 'terminal-host'} style={{ flex: 1, padding: 8, background: '#0c0c0c', display: active ? 'block' : 'none' }} />;
}
