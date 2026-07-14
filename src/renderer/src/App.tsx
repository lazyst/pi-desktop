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
  // Existing sessions on disk (pi's sessions dir), grouped by cwd in the Sidebar.
  const [disk, setDisk] = useState<DiskSession[]>([]);

  useEffect(() => {
    pi.onStatus((key, status) => setStatusMap((m) => ({ ...m, [key]: status })));
    pi.onExit((key) => {
      setStatusMap((m) => ({ ...m, [key]: 'dead' }));
      // Drop the terminated session from the open list so its pane unmounts and
      // the sidebar stops showing a stale (dead) entry.
      setOpen((list) => list.filter((s) => s.key !== key));
    });
    // Seed the sidebar with sessions already on disk (resume).
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

  // The sidebar shows disk sessions plus any live (not-yet-saved) sessions,
  // de-duplicated by key. A disk session that gets opened keeps its key,
  // so it merges naturally and just flips to "running".
  const sessions: DiskSession[] = (() => {
    const diskKeys = new Set(disk.map((s) => s.key));
    const liveOnly = open
      .filter((s) => !diskKeys.has(s.key))
      .map<DiskSession>((s) => ({ key: s.key, cwd: s.cwd, name: s.name }));
    return [...disk, ...liveOnly];
  })();

  const handleOpen = async (req: { key?: string; cwd?: string; name?: string }) => {
    // A bare `{ name }` (from "+ 会话") has no cwd yet. The renderer is sandboxed and
    // has no `process`, so the cwd default is resolved in the main process.
    setError(null);
    try {
      const info = await pi.openSession(req.key ? { key: req.key } : { cwd: req.cwd, name: req.name });
      setOpen((list) => list.some((s) => s.key === info.key) ? list : [...list, info as OpenSession]);
      setActiveKey(info.key);
    } catch (err) {
      // Surface spawn failures instead of failing silently (e.g. `pi` not on PATH).
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const handleTerminate = (key: string) => { pi.terminate(key); };

  const active = open.find((s) => s.key === activeKey);

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0c0c0c', color: '#d4d4d8', fontFamily: 'monospace' }}>
      <Sidebar sessions={sessions} statusMap={statusMap} onOpen={handleOpen} onTerminate={handleTerminate} />
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ height: 34, borderBottom: '1px solid #2a2a36', display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', background: '#16161e' }}>
          <span style={{ fontWeight: 600 }}>{active ? `${active.name} · ${active.cwd}` : '—'}</span>
          <span style={{ fontSize: 11, color: statusMap[activeKey ?? ''] === 'running' ? '#3fb950' : '#8b8b98' }}>
            {statusMap[activeKey ?? ''] === 'running' ? '● 运行中' : '空闲'}
          </span>
          {error && <span style={{ marginLeft: 'auto', fontSize: 11, color: '#f85149' }}>⚠ {error}</span>}
        </div>
        <div style={{ flex: 1, position: 'relative' }}>
          {open.map((s) => (
            <TerminalPane key={s.key} sessionKey={s.key} active={s.key === activeKey} />
          ))}
          {!active && <div style={{ padding: 20, color: '#8b8b98' }}>从左侧选择一个会话，或新建会话。</div>}
        </div>
      </main>
      <style>{`.session-item:hover .terminate { display: inline-flex !important; }`}</style>
    </div>
  );
}
