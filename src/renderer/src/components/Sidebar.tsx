import { useEffect, useState } from 'react';
import { pi } from '../ipc';
import type { SessionGroup, SessionStatus } from '../types';

interface Props {
  statusMap: Record<string, SessionStatus>;
  onOpen: (req: { key?: string; cwd?: string; name?: string }) => void;
  onTerminate: (key: string) => void;
}

export function Sidebar({ statusMap, onOpen, onTerminate }: Props) {
  const [groups, setGroups] = useState<SessionGroup[]>([]);

  useEffect(() => {
    pi.listSessions().then(setGroups).catch(() => setGroups([]));
  }, []);

  return (
    <aside style={{ width: 280, background: '#16161e', borderRight: '1px solid #2a2a36', display: 'flex', flexDirection: 'column', color: '#d4d4d8' }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid #2a2a36', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600 }}>会话</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => {
            const dir = window.prompt('选择目录（真实文件夹路径）：', 'C:\\Users\\hcz\\project');
            if (dir) onOpen({ cwd: dir });
          }}>+ 目录</button>
          <button onClick={() => {
            const name = window.prompt('新会话名称：', 'new-session');
            if (name) onOpen({ cwd: groups[0]?.cwd, name: name ?? undefined });
          }}>+ 会话</button>
        </div>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, padding: '6px 0' }}>
        {groups.map((g) => (
          <div key={g.cwd} className="group" style={{ marginBottom: 4 }}>
            <div style={{ padding: '6px 12px', color: '#8b8b98', fontSize: 11, wordBreak: 'break-all' }}>
              📁 {g.cwd}
            </div>
            {g.sessions.map((s) => {
              const running = statusMap[s.key] === 'running';
              return (
                <div key={s.key} className="session-item" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px 5px 26px', cursor: 'pointer' }}
                     onClick={() => onOpen({ key: s.key })}>
                  <span className={`dot ${running ? 'running' : ''}`} style={{ width: 8, height: 8, borderRadius: '50%', background: running ? '#3fb950' : '#444', flex: 'none' }} />
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                  <button className="terminate" title="终止会话" onClick={(e) => { e.stopPropagation(); onTerminate(s.key); }}
                    style={{ display: 'none', width: 18, height: 18, border: 'none', background: 'transparent', color: '#f85149', cursor: 'pointer' }} >✕</button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}
