import { useEffect, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { ConfirmDialog } from './components/ConfirmDialog';
import { TitleBar } from './components/TitleBar';
import { SettingsPanel } from './components/SettingsPanel';
import { WindowResizeZones } from './components/WindowResizeZones';
import { pi } from './ipc';
import { initTheme } from './theme';
import { defaultConfig } from '../../main/config';
import type { SessionInfo, SessionStatus, AppConfig } from './types';

interface OpenSession extends SessionInfo { key: string; cwd: string; name: string; status: SessionStatus; }
interface DiskSession { key: string; cwd: string; name: string; time?: string; unsaved?: boolean; }

function readPinned(cfg: AppConfig): string[] {
  const arr = cfg.pinnedDirs;
  return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
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
  const [pinned, setPinned] = useState<string[]>([]);
  const [addedDirs, setAddedDirs] = useState<string[]>([]);
  // 侧边栏宽度（持久化于主进程 config.sidebarWidth，见 docs/adr/0001 决策④）。
  const [sidebarWidth, setSidebarWidth] = useState<number>(defaultConfig().sidebarWidth);
  // live `live-<uuid>` key → on-disk `.jsonl` path, set when a new session's file
  // is written. Lets the sidebar highlight the promoted entry as the active one.
  const [liveToDisk, setLiveToDisk] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Same mapping held in a ref so the `onIndex` handler (which fires right after
  // `onRelink` in the same tick) can read the fresh link without stale closure state.
  const liveToDiskRef = useRef<Record<string, string>>({});

  useEffect(() => {
    const offStatus = pi.onStatus((key, status) => setStatusMap((m) => ({ ...m, [key]: status })));
    const offExit = pi.onExit((key) => {
      setStatusMap((m) => ({ ...m, [key]: 'dead' }));
      setOpen((list) => list.filter((s) => s.key !== key));
    });
    // 会话写盘后主进程推送最新索引 → 晋升进侧边栏（需求 1 & 2）。
    // 同时把已晋升的 live 会话在 `open` 中的名称同步为磁盘会话的真实名称
    // （即首条用户消息），这样终端标题从 “new-session” 更新为实际会话名。
    const offIndex = pi.onIndex((groups) => {
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
    const offRelink = pi.onRelink((from, to) => {
      liveToDiskRef.current = { ...liveToDiskRef.current, [from]: to };
      setLiveToDisk(liveToDiskRef.current);
    });
    // 初始化持久化偏好（配置在主进程，需经异步 IPC 读取）：
    pi.getConfig().then((cfg) => { setPinned(readPinned(cfg)); setSidebarWidth(cfg.sidebarWidth); setAddedDirs(Array.isArray(cfg.addedDirs) ? cfg.addedDirs.filter((x) => typeof x === 'string') : []); }).catch(() => setPinned([]));
    initTheme().catch(() => {});
    pi.listSessions().then(toDisk).then(setDisk).catch(() => setDisk([]));
    // 启动动画：首屏（App 挂载）即视为就绪（见 docs/adr/0003 决策⑤a）。
    // 下一帧给 #splash 加 .splash--hidden 触发 CSS 淡出，并通知主进程 show() 窗口。
    // 用 rAF 确保过渡生效（避免同帧加 class 被合并为无过渡）；reduced-motion 下 CSS
    // 已禁用过渡，故等同于直接隐藏。window.pi 缺失（测试）时安全跳过。
    requestAnimationFrame(() => {
      const splash = document.getElementById('splash');
      if (splash) splash.classList.add('splash--hidden');
      pi.splashDone?.();
      // 淡出结束后从 DOM 移除，避免遮挡后续交互（pointer-events 已在 CSS 置 none）。
      setTimeout(() => splash?.remove(), 400);
    });
    return () => { offStatus?.(); offExit?.(); offIndex?.(); offRelink?.(); };
  }, []);

  // 侧边栏只渲染 disk 会话；live 会话默认只活在终端区，发消息写盘后才出现。
  // 但用户希望“未晋升”的 live 会话也立刻显示在左侧栏（按 cwd 混进对应分组，
  // 标 unsaved）。因此此处把尚未晋升的 live 会话也并入侧边栏数据源，
  // 并排除已晋升（已在 liveToDisk 映射中）的 live，避免重复出现两条。
  const promoted = liveToDisk;
  // 真正的“未晋升”会话 key 必为 live-<uuid> 前缀。磁盘 key 本身（如打开
  // 已有会话时返回的 .jsonl 路径）虽会进入 open，但不是 live key，也永远
  // 不会出现在 liveToDisk 映射里——若只用 !promoted[key] 判定，会把已存在
  // 的磁盘会话误当成“未保存”的 live 会话重复显示并打上“未保存”徽标（见修复）。
  const isLiveKey = (k: string) => k.startsWith('live-');
  const liveUnsaved: DiskSession[] = open
    .filter((s) => isLiveKey(s.key) && !promoted[s.key])
    .map((s) => ({ key: s.key, cwd: s.cwd, name: s.name, unsaved: true }));
  // 左侧栏只展示用户“添加目录”显式注册的目录下的会话（含未升级的 live 会话）。
  // 其余磁盘会话不再出现在左侧栏，只可在设置面板“会话管理”中查看与管理。
  const addedSet = new Set(addedDirs);
  const sessions: DiskSession[] = [
    ...disk.filter((d) => addedSet.has(d.cwd)),
    ...liveUnsaved.filter((s) => addedSet.has(s.cwd)),
  ];

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
      // “添加目录”：仅把目录注册进 addedDirs（持久化），左侧栏随即展示该目录下的会话；
      // 不自动新建会话——若目录为空，左侧栏只显示该分组（无会话），由用户按需新建。
      setAddedDirs((prev) => {
        const next = prev.includes(dir) ? prev : [...prev, dir];
        pi.setConfig({ addedDirs: next }).catch(() => {});
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // 从侧边栏移除一个已添加目录：仅从 addedDirs 注销，不删除任何磁盘会话文件。
  const handleRemoveDir = (cwd: string) => {
    setAddedDirs((prev) => {
      const next = prev.filter((c) => c !== cwd);
      pi.setConfig({ addedDirs: next }).catch(() => {});
      return next;
    });
  };

  const handleTogglePin = (cwd: string) => {
    setPinned((prev) => {
      const next = prev.includes(cwd) ? prev.filter((c) => c !== cwd) : [...prev, cwd];
      // config 经异步 IPC 持久化；用 .catch 吸收拒绝（try/catch 抓不到 Promise 拒绝）。
      pi.setConfig({ pinnedDirs: next }).catch(() => {});
      return next;
    });
  };

  // 侧边栏拖拽实时改宽后由 Sidebar 调用，回写 config 并同步本地 state。
  const handleSidebarResize = (w: number) => {
    setSidebarWidth(w);
    pi.setConfig({ sidebarWidth: w }).catch(() => {});
  };

  // 待确认的危险操作：单条删除 / 清空目录 / 批量删除，统一用一份确认弹窗。
  type PendingDelete =
    | { kind: 'session'; key: string; name: string }
    | { kind: 'directory'; cwd: string; count: number }
    | { kind: 'batch'; keys: string[]; count: number };
  const [confirm, setConfirm] = useState<PendingDelete | null>(null);

  // 多选模式：进入后侧边栏每条会话出现 checkbox，点击切换勾选；用于批量删除。
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const handleEnterSelect = () => setSelectionMode(true);
  const handleExitSelect = (clear = true) => {
    setSelectionMode(false);
    if (clear) setSelectedKeys(new Set());
  };
  const handleToggleSelect = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const handleDeleteRequest = (key: string, name: string) => setConfirm({ kind: 'session', key, name });

  const handleClearDirectory = (cwd: string) => {
    const count = disk.filter((d) => d.cwd === cwd).length;
    setConfirm({ kind: 'directory', cwd, count });
  };

  const handleBatchDelete = () => {
    if (selectedKeys.size === 0) return;
    setConfirm({ kind: 'batch', keys: [...selectedKeys], count: selectedKeys.size });
  };

  const handleDeleteConfirm = async () => {
    if (!confirm) return;
    const pending = confirm;
    setConfirm(null);
    setError(null);
    try {
      if (pending.kind === 'session') {
        await pi.deleteSession(pending.key);
      } else if (pending.kind === 'directory') {
        await pi.clearDirectory(pending.cwd);
        handleExitSelect(true); // 清空后退出多选态并清空选择
      } else {
        await pi.deleteMany(pending.keys);
        handleExitSelect(true); // 批量删除后退出多选态并清空选择
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTerminate = (key: string) => { pi.terminate(key); };

  const active = open.find((s) => s.key === activeKey);
  const activeStatus = activeKey ? statusMap[activeKey] : undefined;

  return (
    <div className="app">
      <TitleBar onOpenSettings={() => setSettingsOpen(true)} />
      <div className="app-shell">
      <Sidebar
        sessions={sessions}
        statusMap={statusMap}
        activeKey={activeKey}
        pinned={pinned}
        onOpen={handleOpen}
        onTerminate={handleTerminate}
        onPickDirectory={handlePickDirectory}
        onRemoveDir={handleRemoveDir}
        addedDirs={addedDirs}
        onTogglePin={handleTogglePin}
        onDeleteSession={handleDeleteRequest}
        relink={liveToDisk}
        selectionMode={selectionMode}
        selectedKeys={selectedKeys}
        onToggleSelect={handleToggleSelect}
        onClearDirectory={handleClearDirectory}
        onEnterSelect={handleEnterSelect}
        onExitSelect={handleExitSelect}
        onBatchDelete={handleBatchDelete}
        sidebarWidth={sidebarWidth}
        onSidebarResize={handleSidebarResize}
      />
      <main className="main">
        <div className="header">
          <span className="header-title" title={active ? `${active.name} · ${active.cwd}` : undefined}>{active ? `${active.name} · ${active.cwd}` : '—'}</span>
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
          title={confirm.kind === 'directory' ? '清空目录' : '删除会话'}
          message={
            confirm.kind === 'session'
              ? `确定删除会话「${confirm.name}」？该会话文件将被删除且不可恢复，若进程正在运行也会被终止。`
              : confirm.kind === 'directory'
                ? `确定清空目录「${confirm.cwd}」下的 ${confirm.count} 个会话？运行中的进程将被终止，文件不可恢复。`
                : `确定删除选中的 ${confirm.count} 个会话？运行中的进程将被终止，文件不可恢复。`
          }
          onConfirm={handleDeleteConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
      <WindowResizeZones />
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
    </div>
  );
}
