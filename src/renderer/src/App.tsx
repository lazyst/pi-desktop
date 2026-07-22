import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Sidebar } from './components/Sidebar';
import { ConfirmDialog } from './components/ConfirmDialog';
import { TitleBar } from './components/TitleBar';
import { SettingsPanel } from './components/SettingsPanel';
import { WindowResizeZones } from './components/WindowResizeZones';
import { CenterPane } from './components/CenterPane';
import { RightPanel } from './components/RightPanel';
import { pi } from './ipc';
import { useTabStore } from './store/tabStore';
import { initTheme } from './theme';
import { initFontSize, bumpFontSize, getFontSize, FONT_SIZE_MIN, FONT_SIZE_MAX } from './fontSize';
import { defaultConfig } from '../../main/config';
import type { SessionStatus, AppConfig, TerminalProfile } from './types';
import type { SessionTab } from './store/tabStore';

interface DiskSession { key: string; cwd: string; name: string; time?: string; unsaved?: boolean; }

function readPinned(cfg: AppConfig): string[] {
  const arr = cfg.pinnedDirs;
  return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
}

function toDisk(groups: { cwd: string; sessions: Array<{ key: string; name: string; time: string }> }[]): DiskSession[] {
  return groups.flatMap((g) => g.sessions.map((s) => ({ key: s.key, cwd: g.cwd, name: s.name, time: s.time })));
}

export default function App() {
  // 中间区通用 Tab 模型（重构阶段 3E）：单一状态源已收编进 useTabStore（见 issue 03）。
  // App 不再持有 tabs / activeTabId / closedTabIds，仅把主进程 IPC 事件写回 store，
  // 并派生侧边栏 / 集成终端 cwd 所需的本地视图状态（statusMap / disk / liveToDisk 等）。
  const [statusMap, setStatusMap] = useState<Record<string, SessionStatus>>({});
  const [error, setError] = useState<string | null>(null);
  const [disk, setDisk] = useState<DiskSession[]>([]);
  const [pinned, setPinned] = useState<string[]>([]);
  const [addedDirs, setAddedDirs] = useState<string[]>([]);
  // 应用工作目录分组的根目录（config.appWorkDir，默认 ~/piDesktop）。
  // 该分组下的集成终端不挂靠任何项目 cwd，统一收容闲聊/临时终端。
  const [appWorkDir, setAppWorkDir] = useState<string>('');
  // 侧边栏宽度（持久化于主进程 config.sidebarWidth，见 docs/adr/0001 决策④）。
  const [sidebarWidth, setSidebarWidth] = useState<number>(defaultConfig().sidebarWidth);
  // 右栏（文件树 / Git）宽度（持久化于 config.rightPanelWidth）。
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(defaultConfig().rightPanelWidth);
  // live `live-<uuid>` key → on-disk `.jsonl` path, set when a new session's file
  // is written. Lets the sidebar highlight the promoted entry as the active one.
  const [liveToDisk, setLiveToDisk] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 集成终端实例列表 / 激活状态已收编进 useTabStore（see issue 03）。
  // App 仅保留「终端新建 / 销毁」所需的主进程 IPC 协调逻辑（见下方 handler）。
  // 缓存探测到的 profile 列表，避免每次新建都探测。
  const profilesRef = useRef<TerminalProfile[] | null>(null);
  // 当前激活会话（从 store tabs 派生）：供集成终端 cwd 默认取值、Sidebar 高亮、绿点状态。
  // 中间区 tab / 激活指针直接订阅 store。
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const activeCwd = useTabStore((s) => s.activeCwd);
  // 终端实例列表订阅：仅用于 App 本地的侧边栏分组计数（terminalsByCwd 派生）。
  const terminals = useTabStore((s) => s.terminals);
  const activeSession = tabs.find((t) => t.id === activeTabId && t.kind === 'session') as SessionTab | undefined;
  // 最后活跃会话目录：即使当前激活 tab 是预览/diff，也保留上一次的 cwd，
  // 供右栏文件树/Git 自动模式稳定跟随。
  const [lastSessionCwd, setLastSessionCwd] = useState<string | null>(null);
  useEffect(() => { if (activeCwd) setLastSessionCwd(activeCwd); }, [activeCwd]);
  const activeStatus = activeSession ? statusMap[activeSession.key] : undefined;
  // 文件预览：打开的文件（root + 相对路径 + 可选本地绝对路径用于 webview）。
  // Same mapping held in a ref so the `onRelink` handler (which fires right after
  const liveToDiskRef = useRef<Record<string, string>>({});

  useEffect(() => {
    const offStatus = pi.onStatus((key, status) => setStatusMap((m) => ({ ...m, [key]: status })));
    const offExit = pi.onExit((key) => {
      setStatusMap((m) => ({ ...m, [key]: 'dead' }));
      // 会话进程退出：从中间区 tab 移除对应 session tab（不杀其他 tab）。
      // store 的 removeSessionTab 会同步清理「关闭隐藏（keep-alive）」的 session tab，
      // 不再需要 App 单独维护 closedTabIds 与 ref mirror（见 issue 03）。
      useTabStore.getState().removeSessionTab(key);
    });
    // 会话写盘后主进程推送最新索引 → 晋升进侧边栏（需求 1 & 2）。
    // 同时把已晋升的 live 会话在 `open` 中的名称同步为磁盘会话的真实名称
    // （即首条用户消息），这样终端标题从 “new-session” 更新为实际会话名。
    const offIndex = pi.onIndex((groups) => {
      const diskList = toDisk(groups);
      setDisk(diskList);
      // 磁盘会话默认标记为 'dead'（历史/未启动会话没有存活进程），只有主进程
      // 经 onStatus（reconcile 把 live 进程关联到磁盘 key 时推送 'running'）覆盖为
      // running。这样左侧栏的「终止进程」按钮只对真正运行中的会话显示，而不是
      // 对从未启动/已退出的 .jsonl 历史会话误显（见 issue：未启动会话 hover 也显示
      // 「终止进程」）。仅填充 undefined 项，保留已有的 'running' / 'dead' 状态。
      const diskKeys = diskList.map((d) => d.key);
      setStatusMap((m) => {
        let changed = false;
        const next = { ...m };
        for (const k of diskKeys) {
          if (next[k] === undefined) { next[k] = 'dead'; changed = true; }
        }
        return changed ? next : m;
      });
      const map = liveToDiskRef.current;
      // Promote the display name of a live session once pi writes its `.jsonl`:
      // the header should show the real session name (first user message) instead of
      // the placeholder “new-session”. 名称同步收编进 store（promoteTabNames action）。
      useTabStore.getState().promoteTabNames(diskList);
    });
    const offRelink = pi.onRelink((from, to) => {
      liveToDiskRef.current = { ...liveToDiskRef.current, [from]: to };
      setLiveToDisk(liveToDiskRef.current);
    });
    // 初始化持久化偏好（配置在主进程，需经异步 IPC 读取）：
    pi.getConfig().then((cfg) => { setPinned(readPinned(cfg)); setSidebarWidth(cfg.sidebarWidth); setRightPanelWidth(cfg.rightPanelWidth ?? defaultConfig().rightPanelWidth); setAddedDirs(Array.isArray(cfg.addedDirs) ? cfg.addedDirs.filter((x) => typeof x === 'string') : []); if (cfg.appWorkDir) setAppWorkDir(cfg.appWorkDir); }).catch(() => setPinned([]));
    initTheme().catch(() => {});
    initFontSize().catch(() => {});
    pi.listSessions().then(toDisk).then((diskList) => {
      setDisk(diskList);
      // 初次加载磁盘会话时同样补 'dead' 默认值（同 onIndex 逻辑），避免历史会话
      // 因 statusMap 中无记录（undefined）而在左侧栏误显「终止进程」按钮。
      const init: Record<string, SessionStatus> = {};
      for (const d of diskList) init[d.key] = 'dead';
      setStatusMap((m) => ({ ...init, ...m }));
    }).catch(() => setDisk([]));
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
    // 订阅集成终端进程退出：移除对应 tab，若其为激活态则切到下一个可见 tab。
    const offTermExit = pi.onTerminalExit?.((id) => {
      useTabStore.getState().removeTerminalTab(id);
    });
    // 订阅主进程主动推送的集成终端实例列表（create/destroy/exit 时），
    // 保证左侧分组计数实时（对齐 ADR §6「主动推送，避免轮询」）。
    const offTermList = pi.onTerminalList?.((list) => useTabStore.getState().setTerminals(list));
    return () => { offStatus?.(); offExit?.(); offIndex?.(); offRelink?.(); offTermExit?.(); offTermList?.(); };
  }, []);
  // passive wheel 监听器执行，调用 preventDefault 阻止浏览器原生页面缩放。
  // 滚轮向上（deltaY<0）放大、向下缩小，步长 ±1px，夹在 [FONT_SIZE_MIN, FONT_SIZE_MAX]。
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return; // 仅 Ctrl/Cmd+滚轮触发；普通滚动留给终端/页面。
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      // 高通：忽略极小的物理刻度抖动，避免误触微调（触控板小步幅仍生效）。
      if (Math.abs(e.deltaY) < 1) return;
      bumpFontSize(dir);
    };
    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => { window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions); };
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
  const liveUnsaved: DiskSession[] = tabs
    .filter((t): t is SessionTab => t.kind === 'session' && isLiveKey(t.key) && !promoted[t.key])
    .map((t) => ({ key: t.key, cwd: t.cwd, name: t.name, unsaved: true }));
  // 左侧栏只展示用户“添加目录”显式注册的目录下的会话（含未升级的 live 会话）。
  // 「应用工作目录」(appWorkDir) 也作为隐式允许的目录纳入——它虽不写在 addedDirs 里，
  // 但其下同样会产生会话（如在该分组新建会话），必须能显示在左栏（见 issue：在
  // 应用工作目录新建会话后左侧栏看不到）。其余磁盘会话不出现，仅在设置面板“会话管理”。
  // 注：appWorkDir 可能为空串（配置未就绪），空串不会匹配任何会话 cwd，安全跳过。
  const visibleDirs = useMemo(() => {
    const set = new Set(addedDirs);
    if (appWorkDir) set.add(appWorkDir);
    return set;
  }, [addedDirs, appWorkDir]);
  const addedSet = visibleDirs;
  const sessions: DiskSession[] = [
    ...disk.filter((d) => addedSet.has(d.cwd)),
    ...liveUnsaved.filter((s) => addedSet.has(s.cwd)),
  ];

  // 集成终端按 cwd 聚合计数（纯终端数，不含 pi 会话数）：
  //  - 终端 cwd === appWorkDir → 归入「应用工作目录」分组；
  //  - 否则若命中某会话分组 cwd → 归入该项目分组；
  //  - 其余（历史遗留 / 改 appWorkDir 前的旧终端，无对应会话分组）→ 归入空串兜底 key，
  //    不污染 appWorkDir 计数（对齐 ADR §4/§5.3）。渲染层对该兜底 key 不显示徽标。
  // 关键：appWorkDir 优先于项目 cwd 判定，避免「应用目录 == 某项目目录」时双重计数。
  const terminalsByCwd = useMemo(() => {
    const map = new Map<string, number>();
    const sessionCwds = new Set(sessions.map((s) => s.cwd));
    for (const t of terminals) {
      const owner = appWorkDir && t.cwd === appWorkDir
        ? appWorkDir
        : sessionCwds.has(t.cwd)
          ? t.cwd
          : ''; // 无匹配分组（历史/旧终端）兜底进空串 key
      map.set(owner, (map.get(owner) ?? 0) + 1);
    }
    return map;
  }, [terminals, appWorkDir, sessions]);

  const handleOpen = async (req: { key?: string; cwd?: string; name?: string }) => {
    setError(null);
    try {
      const info = await pi.openSession(req.key ? { key: req.key } : { cwd: req.cwd, name: req.name });
      // 新增或激活 session tab 统一收编进 store（openSession action 已封装「已存在则
      // 取消隐藏并激活、不存在则新增并激活」逻辑，与「关闭=隐藏、重开=恢复」语义一致）。
      useTabStore.getState().openSession({ key: info.key, cwd: info.cwd, name: info.name });
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

  // 点击文件树中的文件 → 中间区新增/激活预览 tab（单文件）。
  const handleOpenFile = (relPath: string, fileName: string, root: string) => {
    // 统一收编进 store（openPreview action 封装「已存在则激活、不存在则新增」）。
    // title 由 store 按 fileName 或 path 末段计算，对应用户可见的文件名。
    useTabStore.getState().openPreview(root, relPath, fileName);
  };

  // 点击 Git 面板的「工作区改动」或某次提交 → 中间区新增/激活 diff tab（替代旧式 GitDiffDrawer）。
  // commitHash 为 null 时显示工作区 diff；为某 hash 时显示该提交 diff。
  const openWorkDiff = useCallback((cwd: string) => {
    useTabStore.getState().openDiff(cwd, null);
  }, []);
  const openCommitDiff = useCallback((cwd: string, hash: string) => {
    useTabStore.getState().openDiff(cwd, hash);
  }, []);

  const handleSidebarResize = (w: number) => {
    setSidebarWidth(w);
    pi.setConfig({ sidebarWidth: w }).catch(() => {});
  };

  // 右栏（文件树 / Git）拖拽右缘实时改宽后回写 config 并同步本地 state。
  const handleRightPanelResize = (w: number) => {
    setRightPanelWidth(w);
    pi.setConfig({ rightPanelWidth: w }).catch(() => {});
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

  // —— 集成终端创建 ——
  // 在指定目录创建集成终端。若未指定 cwd，使用当前活跃目录。
  const appWorkDirRef = useRef(appWorkDir);
  appWorkDirRef.current = appWorkDir;

  const doCreateTerminal = useCallback(async (cwd?: string) => {
    try {
      if (!profilesRef.current) profilesRef.current = await pi.listTerminalProfiles();
      const profiles = profilesRef.current;
      const cfg = await pi.getConfig();
      const defaultId = cfg.defaultTerminalProfile;
      const profile = (defaultId && profiles.find((p) => p.id === defaultId)) || profiles[0];
      if (!profile) return;
      const targetCwd = cwd || useTabStore.getState().activeCwd || appWorkDirRef.current || defaultConfig().appWorkDir || '';
      const info = await pi.spawnTerminal({ command: undefined, cwd: targetCwd, profile });
      useTabStore.getState().openTerminal(info.id, info.cwd, info.title);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleNewTerminalInCwd = useCallback((cwd: string) => doCreateTerminal(cwd), [doCreateTerminal]);
  const handleNewTerminalInAppWorkDir = useCallback(() => doCreateTerminal(appWorkDirRef.current || ''), [doCreateTerminal]);

  // 点击侧边栏目录名称 → 切换到该目录的 tab 条，不打开新会话。
  const handleSelectCwd = useCallback((cwd: string) => {
    useTabStore.getState().setActiveCwd(cwd);
  }, []);

  // 集成终端 × 关闭：杀 PTY 再移除 tab（区别于 session 的 keep-alive 隐藏）。
  // 对齐用户预期：关闭终端 tab ≡ 终止终端进程，侧边栏计数相应减一。
  // 必须异步：pi.destroyTerminal 返回 Promise，主进程处理完后 push term:list。
  const handleDestroyTerminal = useCallback(async (id: string) => {
    try {
      await pi.destroyTerminal(id);
      // destroyTerminal 触发主进程 terminal:destroy → pushTerminalList →
      // term:list IPC → onTerminalList → setTerminals → 侧边栏计数自动更新。
      useTabStore.getState().closeTab(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <div className="app">
      <TitleBar onOpenSettings={() => setSettingsOpen(true)} />
      <div className="app-shell">
      <Sidebar
        sessions={sessions}
        statusMap={statusMap}
        activeKey={activeSession?.key ?? null}
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
        appWorkDir={appWorkDir}
        terminalsByCwd={terminalsByCwd}
        onNewTerminalInAppWorkDir={handleNewTerminalInAppWorkDir}
        onNewTerminalInCwd={handleNewTerminalInCwd}
        onSelectCwd={handleSelectCwd}
      />
      <CenterPane
        onOpenFile={handleOpenFile}
        onDestroyTerminal={handleDestroyTerminal}
      />
      <RightPanel
        addedDirs={Array.from(visibleDirs)}
        activeCwd={lastSessionCwd}
        onOpenFile={handleOpenFile}
        onOpenWorkDiff={openWorkDiff}
        onOpenCommit={openCommitDiff}
        width={rightPanelWidth}
        onResize={handleRightPanelResize}
      />
      </div>
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
  );
}
