import { useState } from 'react';
import type { SessionStatus } from '../types';
import { IconNewSession, IconPin } from './icons';

interface Session { key: string; cwd: string; name: string; time?: string; }
interface Props {
  sessions: Session[];
  statusMap: Record<string, SessionStatus>;
  activeKey?: string | null;
  pinned: string[];
  onOpen: (req: { key?: string; cwd?: string; name?: string }) => void;
  onTerminate: (key: string) => void;
  onPickDirectory: () => void;
  onTogglePin: (cwd: string) => void;
}

export function Sidebar({ sessions, statusMap, activeKey, pinned, onOpen, onTerminate, onPickDirectory, onTogglePin }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // 分组按 cwd；置顶分组排到最前（保持置顶先后顺序），其余维持原序。
  const pinnedSet = new Set(pinned);
  const rawGroups: Array<{ cwd: string; items: Session[] }> = [];
  const cwdIndex = new Map<string, number>();
  for (const s of sessions) {
    let i = cwdIndex.get(s.cwd);
    if (i === undefined) { i = rawGroups.length; cwdIndex.set(s.cwd, i); rawGroups.push({ cwd: s.cwd, items: [] }); }
    rawGroups[i].items.push(s);
  }
  const groups = [...rawGroups].sort((a, b) => {
    const pa = pinnedSet.has(a.cwd) ? pinned.indexOf(a.cwd) : Number.MAX_SAFE_INTEGER;
    const pb = pinnedSet.has(b.cwd) ? pinned.indexOf(b.cwd) : Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">会话</span>
        <div className="sidebar-actions">
          <button className="btn" onClick={onPickDirectory}>+ 目录</button>
        </div>
      </div>
      <div className="session-list">
        {groups.map((g) => {
          const isPinned = pinnedSet.has(g.cwd);
          const isOpen = !!expanded[g.cwd];
          const visible = isOpen ? g.items : g.items.slice(0, 5);
          const hidden = g.items.length - visible.length;
          return (
            <div key={g.cwd} className={`group${isPinned ? ' pinned' : ''}`}>
              <div className="group-title">
                <span className="group-name">📁 {g.cwd}</span>
                <span className="group-actions">
                  <button
                    className="icon-btn"
                    title={`置顶 ${g.cwd}`}
                    aria-label={`置顶 ${g.cwd}`}
                    data-action="pin"
                    onClick={() => onTogglePin(g.cwd)}
                  >
                    <IconPin />
                  </button>
                  <button
                    className="icon-btn"
                    title={`在 ${g.cwd} 新建会话`}
                    aria-label={`在 ${g.cwd} 新建会话`}
                    data-action="new-session"
                    onClick={() => onOpen({ cwd: g.cwd })}
                  >
                    <IconNewSession />
                  </button>
                </span>
              </div>
              {visible.map((s) => {
                const running = statusMap[s.key] === 'running';
                const isActive = s.key === activeKey;
                return (
                  <div
                    key={s.key}
                    data-key={s.key}
                    className={`session-item${isActive ? ' active' : ''}`}
                    tabIndex={0}
                    aria-label={`打开会话 ${s.name}`}
                    onClick={() => onOpen({ key: s.key })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpen({ key: s.key });
                      }
                    }}
                  >
                    <span className={`dot ${running ? 'running' : ''}`} />
                    <span className="session-name">
                      <div className="name">{s.name}</div>
                      {s.time && <div className="time">{s.time}</div>}
                    </span>
                    {running && (
                      <button className="terminate" title="终止进程" onClick={(e) => { e.stopPropagation(); onTerminate(s.key); }}>终止进程</button>
                    )}
                  </div>
                );
              })}
              {g.items.length > 5 && (
                <div
                  className="group-expand"
                  onClick={() => setExpanded((m) => ({ ...m, [g.cwd]: !isOpen }))}
                >
                  {isOpen ? '收起' : `展开 ${hidden} 个更多`}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
