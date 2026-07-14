import { useState } from 'react';
import type { SessionStatus } from '../types';

interface Props {
  sessions: Array<{ key: string; cwd: string; name: string; time?: string }>;
  statusMap: Record<string, SessionStatus>;
  activeKey?: string | null;
  onOpen: (req: { key?: string; cwd?: string; name?: string }) => void;
  onTerminate: (key: string) => void;
}

interface PromptState {
  label: string;
  defaultValue: string;
  onOk: (value: string) => void;
}

export function Sidebar({ sessions, statusMap, activeKey, onOpen, onTerminate }: Props) {
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const openPrompt = (cfg: PromptState) => {
    setInputValue(cfg.defaultValue);
    setPrompt(cfg);
  };

  const groups: Array<{ cwd: string; items: Props['sessions'] }> = [];
  const cwdIndex = new Map<string, number>();
  for (const s of sessions) {
    let i = cwdIndex.get(s.cwd);
    if (i === undefined) {
      i = groups.length;
      cwdIndex.set(s.cwd, i);
      groups.push({ cwd: s.cwd, items: [] });
    }
    groups[i].items.push(s);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">会话</span>
        <div className="sidebar-actions">
          <button className="btn" onClick={() => openPrompt({
            label: '选择目录（真实文件夹路径）：',
            defaultValue: 'C:\\Users\\hcz\\project',
            onOk: (dir) => { if (dir) onOpen({ cwd: dir }); },
          })}>+ 目录</button>
          <button className="btn" onClick={() => openPrompt({
            label: '新会话名称：',
            defaultValue: 'new-session',
            onOk: (name) => { if (name) onOpen({ name }); },
          })}>+ 会话</button>
        </div>
      </div>
      <div className="session-list">
        {groups.map((g) => {
          const isOpen = !!expanded[g.cwd];
          const visible = isOpen ? g.items : g.items.slice(0, 5);
          const hidden = g.items.length - visible.length;
          return (
            <div key={g.cwd} className="group">
              <div className="group-title">📁 {g.cwd}</div>
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

      {prompt && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-label">{prompt.label}</div>
            <input
              className="modal-input"
              value={inputValue}
              autoFocus
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { setPrompt(null); prompt.onOk(inputValue); } }}
            />
            <div className="modal-actions">
              <button className="btn modal-cancel" onClick={() => setPrompt(null)}>取消</button>
              <button className="btn btn-primary modal-ok" onClick={() => { setPrompt(null); prompt.onOk(inputValue); }}>确定</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
