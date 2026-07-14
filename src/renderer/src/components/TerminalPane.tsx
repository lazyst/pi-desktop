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

    return () => {
      term.dispose();
      // Note: pi.onData has no off(); a production build should track and ignore stale keys.
    };
  }, [sessionKey]);

  useEffect(() => {
    if (!hostRef.current || !termRef.current || !fitRef.current) return;
    termRef.current.open(hostRef.current);
    try { fitRef.current.fit(); } catch {}
    const { cols, rows } = termRef.current;
    pi.resize(sessionKey, cols, rows);
  }, [active, sessionKey]);

  return <div ref={hostRef} data-session={sessionKey} className={active ? 'terminal-host active' : 'terminal-host'} style={{ flex: 1, padding: 8, background: '#0c0c0c', display: active ? 'block' : 'none' }} />;
}
