import { useState } from 'react';
import type { SessionStatus } from '../types';

interface Props {
  sessions: Array<{ key: string; cwd: string; name: string; status: SessionStatus }>;
  statusMap: Record<string, SessionStatus>;
  onOpen: (req: { key?: string; cwd?: string; name?: string }) => void;
  onTerminate: (key: string) => void;
}

interface PromptState {
  label: string;
  defaultValue: string;
  onOk: (value: string) => void;
}

export function Sidebar({ sessions, statusMap, onOpen, onTerminate }: Props) {
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [inputValue, setInputValue] = useState('');

  const openPrompt = (cfg: PromptState) => {
    setInputValue(cfg.defaultValue);
    setPrompt(cfg);
  };

  // Group the OPEN sessions by cwd, preserving first-seen order.
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
    <aside style={{ width: 280, background: '#16161e', borderRight: '1px solid #2a2a36', display: 'flex', flexDirection: 'column', color: '#d4d4d8', position: 'relative' }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid #2a2a36', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600 }}>会话</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => openPrompt({
            label: '选择目录（真实文件夹路径）：',
            defaultValue: 'C:\\Users\\hcz\\project',
            onOk: (dir) => { if (dir) onOpen({ cwd: dir }); },
          })}>+ 目录</button>
          <button onClick={() => openPrompt({
            label: '新会话名称：',
            defaultValue: 'new-session',
            onOk: (name) => { if (name) onOpen({ name }); },
          })}>+ 会话</button>
        </div>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, padding: '6px 0' }}>
        {groups.map((g) => (
          <div key={g.cwd} className="group" style={{ marginBottom: 4 }}>
            <div style={{ padding: '6px 12px', color: '#8b8b98', fontSize: 11, wordBreak: 'break-all' }}>
              📁 {g.cwd}
            </div>
            {g.items.map((s) => {
              const running = (statusMap[s.key] ?? 'running') === 'running';
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

      {prompt && (
        <div className="modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#16161e', border: '1px solid #2a2a36', padding: 16, borderRadius: 6, minWidth: 320 }}>
            <div style={{ marginBottom: 8, color: '#d4d4d8' }}>{prompt.label}</div>
            <input
              className="modal-input"
              value={inputValue}
              autoFocus
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { setPrompt(null); prompt.onOk(inputValue); } }}
              style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', background: '#0c0c0c', border: '1px solid #2a2a36', color: '#d4d4d8' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button className="modal-cancel" onClick={() => setPrompt(null)}>取消</button>
              <button className="modal-ok" onClick={() => { setPrompt(null); prompt.onOk(inputValue); }}>确定</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
