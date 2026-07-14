import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { pi } from './ipc';
import type { SessionInfo, SessionStatus } from './types';

interface OpenSession extends SessionInfo { key: string; cwd: string; name: string; status: SessionStatus; }

interface DiskSession { key: string; cwd: string; name: string; time?: string; }

export default function App() {
  const [open, setOpen] = useState<OpenSession[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<Record<string, SessionStatus>>({});
  const [error, setError] = useState<string | null>(null);
  const [disk, setDisk] = useState<DiskSession[]>([]);

  useEffect(() => {
    pi.onStatus((key, status) => setStatusMap((m) => ({ ...m, [key]: status })));
    pi.onExit((key) => {
      setStatusMap((m) => ({ ...m, [key]: 'dead' }));
      setOpen((list) => list.filter((s) => s.key !== key));
    });
    pi.listSessions()
      .then((groups) =>
        setDisk(
          groups.flatMap((g) =>
            g.sessions.map((s) => ({ key: s.key, cwd: g.cwd, name: s.name, time: s.time })),
          ),
        ),
      )
      .catch(() => setDisk([]));
  }, []);

  const sessions: DiskSession[] = (() => {
    const diskKeys = new Set(disk.map((s) => s.key));
    const liveOnly = open
      .filter((s) => !diskKeys.has(s.key))
      .map<DiskSession>((s) => ({ key: s.key, cwd: s.cwd, name: s.name }));
    return [...disk, ...liveOnly];
  })();

  const handleOpen = async (req: { key?: string; cwd?: string; name?: string }) => {
    setError(null);
    try {
      const info = await pi.openSession(req.key ? { key: req.key } : { cwd: req.cwd, name: req.name });
      setOpen((list) => list.some((s) => s.key === info.key) ? list : [...list, info as OpenSession]);
      setActiveKey(info.key);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const handleTerminate = (key: string) => { pi.terminate(key); };

  const active = open.find((s) => s.key === activeKey);
  const activeStatus = activeKey ? statusMap[activeKey] : undefined;

  return (
    <div className="app-shell">
      <Sidebar sessions={sessions} statusMap={statusMap} activeKey={activeKey} onOpen={handleOpen} onTerminate={handleTerminate} />
      <main className="main">
        <div className="header">
          <span className="header-title">{active ? `${active.name} · ${active.cwd}` : '—'}</span>
          <span className={`header-status ${activeStatus === 'running' ? 'running' : ''}`}>
            {activeStatus === 'running' ? '● 运行中' : '空闲'}
          </span>
          {error && <span className="header-error">⚠ {error}</span>}
        </div>
        <div className="terminal-area">
          {open.map((s) => (
            <TerminalPane key={s.key} sessionKey={s.key} active={s.key === activeKey} />
          ))}
          {!active && <div className="empty-state">从左侧选择一个会话，或新建会话。</div>}
        </div>
      </main>
    </div>
  );
}
