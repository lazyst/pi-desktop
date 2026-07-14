import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { pi } from './ipc';
import type { SessionInfo, SessionStatus } from './types';

interface OpenSession extends SessionInfo { key: string; cwd: string; name: string; status: SessionStatus; }

export default function App() {
  const [open, setOpen] = useState<OpenSession[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<Record<string, SessionStatus>>({});

  useEffect(() => {
    pi.onStatus((key, status) => setStatusMap((m) => ({ ...m, [key]: status })));
    pi.onExit((key) => setStatusMap((m) => ({ ...m, [key]: 'dead' })));
  }, []);

  const handleOpen = async (req: { key?: string; cwd?: string; name?: string }) => {
    const info = await pi.openSession(req);
    setOpen((list) => list.some((s) => s.key === info.key) ? list : [...list, info as OpenSession]);
    setActiveKey(info.key);
  };
  const handleTerminate = (key: string) => { pi.terminate(key); };

  const active = open.find((s) => s.key === activeKey);

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0c0c0c', color: '#d4d4d8', fontFamily: 'monospace' }}>
      <Sidebar statusMap={statusMap} onOpen={handleOpen} onTerminate={handleTerminate} />
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ height: 34, borderBottom: '1px solid #2a2a36', display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', background: '#16161e' }}>
          <span style={{ fontWeight: 600 }}>{active ? `${active.name} · ${active.cwd}` : '—'}</span>
          <span style={{ fontSize: 11, color: statusMap[activeKey ?? ''] === 'running' ? '#3fb950' : '#8b8b98' }}>
            {statusMap[activeKey ?? ''] === 'running' ? '● 运行中' : '空闲'}
          </span>
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
