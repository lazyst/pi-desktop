import { useEffect, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { ConfirmDialog } from './components/ConfirmDialog';
import { pi } from './ipc';
import type { SessionInfo, SessionStatus } from './types';

interface OpenSession extends SessionInfo { key: string; cwd: string; name: string; status: SessionStatus; }
interface DiskSession { key: string; cwd: string; name: string; time?: string; }

const PIN_KEY = 'pi-desktop:pinned-dirs';

function readPinned(): string[] {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toDisk(groups: { cwd: string; sessions: Array<{ key: string; name: string; time: string }> }[]): DiskSession[] {
  return groups.flatMap((g) => g.sessions.map((s) => ({ key: s.key, cwd: g.cwd, name: s.name, time: s.time })));
}

export default function App() {
  const [open, setOpen] = useState<OpenSession[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<Record<string, SessionStatus>>({});
  const [error, setError] = useState<string | null>(null);
  const [disk, setDisk] = useState<DiskSession[]>([]);
  const [pinned, setPinned] = useState<string[]>(() => readPinned());
  // live `live-<uuid>` key → on-disk `.jsonl` path, set when a new session's file
  // is written. Lets the sidebar highlight the promoted entry as the active one.
  const [liveToDisk, setLiveToDisk] = useState<Record<string, string>>({});
  // Same mapping held in a ref so the `onIndex` handler (which fires right after
  // `onRelink` in the same tick) can read the fresh link without stale closure state.
  const liveToDiskRef = useRef<Record<string, string>>({});

  useEffect(() => {
    pi.onStatus((key, status) => setStatusMap((m) => ({ ...m, [key]: status })));
    pi.onExit((key) => {
      setStatusMap((m) => ({ ...m, [key]: 'dead' }));
      setOpen((list) => list.filter((s) => s.key !== key));
    });
    // 会话写盘后主进程推送最新索引 → 晋升进侧边栏（需求 1 & 2）。
    // 同时把已晋升的 live 会话在 `open` 中的名称同步为磁盘会话的真实名称
    // （即首条用户消息），这样终端标题从 “new-session” 更新为实际会话名。
    pi.onIndex((groups) => {
      const diskList = toDisk(groups);
      setDisk(diskList);
      const map = liveToDiskRef.current;
      // Promote the display name of a live session once pi writes its `.jsonl`:
      // the header should show the real session name (first user message) instead of
      // the placeholder “new-session”.
      setOpen((list) => {
        let changed = false;
        const next = list.map((s) => {
          const dk = map[s.key];
          if (!dk) return s;
          const d = diskList.find((x) => x.key === dk);
          if (d && d.name && d.name !== s.name) { changed = true; return { ...s, name: d.name }; }
          return s;
        });
        return changed ? next : list;
      });
    });
    pi.onRelink((from, to) => {
      liveToDiskRef.current = { ...liveToDiskRef.current, [from]: to };
      setLiveToDisk(liveToDiskRef.current);
    });
    pi.listSessions().then(toDisk).then(setDisk).catch(() => setDisk([]));
  }, []);

  // 侧边栏只渲染 disk 会话；live 会话只活在终端区，发消息写盘后才出现。
  const sessions: DiskSession[] = disk;

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

  const handlePickDirectory = async () => {
    setError(null);
    try {
      const dir = await pi.pickDirectory();
      if (!dir) return;
      await handleOpen({ cwd: dir });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTogglePin = (cwd: string) => {
    setPinned((prev) => {
      const next = prev.includes(cwd) ? prev.filter((c) => c !== cwd) : [...prev, cwd];
      try { localStorage.setItem(PIN_KEY, JSON.stringify(next)); } catch { /* ignore quota */ }
      return next;
    });
  };

  const [confirm, setConfirm] = useState<{ key: string; name: string } | null>(null);

  const handleDeleteRequest = (key: string, name: string) => setConfirm({ key, name });

  const handleDeleteConfirm = async () => {
    if (!confirm) return;
    const { key } = confirm;
    setConfirm(null);
    setError(null);
    try {
      await pi.deleteSession(key);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTerminate = (key: string) => { pi.terminate(key); };

  const active = open.find((s) => s.key === activeKey);
  const activeStatus = activeKey ? statusMap[activeKey] : undefined;

  return (
    <div className="app-shell">
      <Sidebar
        sessions={sessions}
        statusMap={statusMap}
        activeKey={activeKey}
        pinned={pinned}
        onOpen={handleOpen}
        onTerminate={handleTerminate}
        onPickDirectory={handlePickDirectory}
        onTogglePin={handleTogglePin}
        onDeleteSession={handleDeleteRequest}
        relink={liveToDisk}
      />
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
      {confirm && (
        <ConfirmDialog
          title="删除会话"
          message={`确定删除会话「${confirm.name}」？该会话文件将被删除且不可恢复，若进程正在运行也会被终止。`}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
