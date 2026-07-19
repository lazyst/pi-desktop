import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { ConfirmDialog } from './components/ConfirmDialog';
import { TitleBar } from './components/TitleBar';
import { TerminalDrawer } from './components/TerminalDrawer';
import { SettingsPanel } from './components/SettingsPanel';
import { WindowResizeZones } from './components/WindowResizeZones';
import { FilePanel } from './components/FilePanel';
import { FileDrawer, type DrawerFile } from './components/FileDrawer';
import { pi } from './ipc';
import { initTheme } from './theme';
import { initFontSize, bumpFontSize, getFontSize, FONT_SIZE_MIN, FONT_SIZE_MAX } from './fontSize';
import { defaultConfig } from '../../main/config';
import type { SessionInfo, SessionStatus, AppConfig, IntegratedTerminalInfo, TerminalProfile } from './types';

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
  // 应用工作目录分组的根目录（config.appWorkDir，默认 ~/piDesktop）。
  // 该分组下的集成终端不挂靠任何项目 cwd，统一收容闲聊/临时终端。
  const [appWorkDir, setAppWorkDir] = useState<string>('');
  // 侧边栏宽度（持久化于主进程 config.sidebarWidth，见 docs/adr/0001 决策④）。
  const [sidebarWidth, setSidebarWidth] = useState<number>(defaultConfig().sidebarWidth);
  // 文件管理器面板宽度（持久化于 config.filePanelWidth）。
  const [filePanelWidth, setFilePanelWidth] = useState<number>(defaultConfig().filePanelWidth);
  // live `live-<uuid>` key → on-disk `.jsonl` path, set when a new session's file
  // is written. Lets the sidebar highlight the promoted entry as the active one.
  const [liveToDisk, setLiveToDisk] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 集成终端抽屉（底部抽屉）：开关、已开终端列表、当前激活 tab、抽屉高度。
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [terminals, setTerminals] = useState<IntegratedTerminalInfo[]>([]);
  const [activeTermId, setActiveTermId] = useState<string | null>(null);
  const [drawerHeight, setDrawerHeight] = useState<number>(defaultConfig().terminalDrawerHeight);
  // 缓存探测到的 profile 列表，避免每次新建都探测。
  const profilesRef = useRef<TerminalProfile[] | null>(null);
  // 镜像 terminals 到 ref，供 onTerminalExit 等只订阅一次的回调读取最新值（避免闭包陈旧）。
  const terminalsRef = useRef<IntegratedTerminalInfo[]>([]);
  terminalsRef.current = terminals;
  // 当前激活会话（供集成终端 cwd 默认取值）。提前计算，供 handler 的依赖数组使用。
  const active = open.find((s) => s.key === activeKey);
  const activeStatus = activeKey ? statusMap[activeKey] : undefined;
  const activeCwd = active?.cwd ?? null;
  // 文件预览抽屉：打开的文件（root + 相对路径 + 可选本地绝对路径用于 webview）。
  // Same mapping held in a ref so the `onRelink` handler (which fires right after
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
    pi.getConfig().then((cfg) => { setPinned(readPinned(cfg)); setSidebarWidth(cfg.sidebarWidth); setFilePanelWidth(cfg.filePanelWidth); if (cfg.terminalDrawerHeight) setDrawerHeight(cfg.terminalDrawerHeight); setAddedDirs(Array.isArray(cfg.addedDirs) ? cfg.addedDirs.filter((x) => typeof x === 'string') : []); if (cfg.appWorkDir) setAppWorkDir(cfg.appWorkDir); }).catch(() => setPinned([]));
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
    // 订阅集成终端进程退出（用户 exit / kill）：移除对应 tab，若其为激活态则切到剩余第一个或 null。
    // 注意：用户点 × 关闭 tab 也会触发 destroyTerminal → 主进程可能再发 exit；用函数式更新 + 存在性
    // 判断即可（重复移除无害）。
    const offTermExit = pi.onTerminalExit?.((id) => {
      setTerminals((prev) => prev.filter((t) => t.id !== id));
      setActiveTermId((prev) => {
        if (prev !== id) return prev;
        const remaining = terminalsRef.current.filter((t) => t.id !== id);
        return remaining.length ? remaining[0].id : null;
      });
    });
    // 订阅主进程主动推送的集成终端实例列表（create/destroy/exit 时），
    // 保证左侧分组计数实时（对齐 ADR §6「主动推送，避免轮询」）。
    const offTermList = pi.onTerminalList?.((list) => setTerminals(list));
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
  const liveUnsaved: DiskSession[] = open
    .filter((s) => isLiveKey(s.key) && !promoted[s.key])
    .map((s) => ({ key: s.key, cwd: s.cwd, name: s.name, unsaved: true }));
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

  // 点击文件树中的文件 → 打开右侧预览抽屉（单文件）。
  const [drawerFile, setDrawerFile] = useState<DrawerFile | null>(null);
  const handleOpenFile = (relPath: string, _fileName: string, root: string) => {
    // 渲染进程是 sandbox（无 Node 集成），不能用 node:path；用纯字符串拼出
    // 本地绝对路径（仅 PDF webview 需要）。file:// 对 / 与 \\ 均接受。
    const absPath = root ? `${root.replace(/[\\/]+$/, '')}/${relPath.replace(/^[/\\]+/, '')}` : relPath;
    setDrawerFile({ root, path: relPath, absPath });
  };

  const handleSidebarResize = (w: number) => {
    setSidebarWidth(w);
    pi.setConfig({ sidebarWidth: w }).catch(() => {});
  };

  // 文件管理器面板拖拽右缘实时改宽后回写 config 并同步本地 state。
  const handleFilePanelResize = (w: number) => {
    setFilePanelWidth(w);
    pi.setConfig({ filePanelWidth: w }).catch(() => {});
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

  // —— 集成终端抽屉逻辑 ——
  // 新建终端：打开抽屉 → 取 profile（缓存）→ 选 profile（config.defaultTerminalProfile 或第一个）→ 创建。
  const handleNewTerminal = useCallback(async () => {
    setDrawerOpen(true);
    try {
      // 1. 取 profile 列表（缓存）
      if (!profilesRef.current) profilesRef.current = await pi.listTerminalProfiles();
      const profiles = profilesRef.current;
      // 2. 选 profile：config.defaultTerminalProfile 指定的 id，否则第一个
      const cfg = await pi.getConfig();
      const defaultId = cfg.defaultTerminalProfile;
      const profile = (defaultId && profiles.find((p) => p.id === defaultId)) || profiles[0];
      if (!profile) return; // 无可用 shell（极罕见）
      // 3. cwd：当前激活会话 cwd，否则空（主进程侧已 fallback）
      const cwd = activeCwd ?? '';
      // 注意：不在此处本地 setTerminals 追加——主进程 terminal:create 后会经
      // onTerminalList 主动推送完整列表（单一事实来源，见下方订阅）。若此处再
      // 追加一次，会与推送的整表合并成同一 id 出现两次 → 面板出现两个相同 tab。
      // 此处只负责触发创建 + 设定激活态（激活态由返回 info 直接确定）。
      const info = await pi.createTerminal({ profile, cwd });
      setActiveTermId(info.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeCwd]);

  // 在「应用工作目录」分组下新建终端：cwd 取 config.appWorkDir（主进程确保目录存在）。
  const handleNewTerminalInAppWorkDir = useCallback(async () => {
    setDrawerOpen(true);
    try {
      if (!profilesRef.current) profilesRef.current = await pi.listTerminalProfiles();
      const profiles = profilesRef.current;
      const cfg = await pi.getConfig();
      const defaultId = cfg.defaultTerminalProfile;
      const profile = (defaultId && profiles.find((p) => p.id === defaultId)) || profiles[0];
      if (!profile) return;
      const info = await pi.createTerminalInAppWorkDir({ profile });
      setActiveTermId(info.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 在指定项目目录（cwd）分组下新建集成终端：cwd 取该分组目录。
  const handleNewTerminalInCwd = useCallback(async (cwd: string) => {
    setDrawerOpen(true);
    try {
      if (!profilesRef.current) profilesRef.current = await pi.listTerminalProfiles();
      const profiles = profilesRef.current;
      const cfg = await pi.getConfig();
      const defaultId = cfg.defaultTerminalProfile;
      const profile = (defaultId && profiles.find((p) => p.id === defaultId)) || profiles[0];
      if (!profile) return;
      const info = await pi.createTerminal({ profile, cwd });
      setActiveTermId(info.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 关闭 tab：移除本地列表 + 通知主进程销毁；若关掉的是激活态则切到剩余第一个或 null；
  // 关掉最后一个则自动收起抽屉。
  const handleCloseTab = useCallback((id: string) => {
    setTerminals((prev) => {
      const next = prev.filter((t) => t.id !== id);
      // 关掉最后一个则自动收起抽屉（在函数式更新内判断，避免读到陈旧 ref）
      if (next.length === 0) setDrawerOpen(false);
      return next;
    });
    pi.destroyTerminal(id).catch(() => {});
    setActiveTermId((prev) => {
      if (prev !== id) return prev;
      const remaining = terminalsRef.current.filter((t) => t.id !== id);
      return remaining.length ? remaining[0].id : null;
    });
    // 若关掉最后一个，自动收起抽屉
    if (terminalsRef.current.length <= 1) setDrawerOpen(false);
  }, []);

  // 抽屉高度拖拽：实时改 state 并回写 config。
  const handleResizeDrawer = useCallback((h: number) => {
    setDrawerHeight(h);
    pi.setConfig({ terminalDrawerHeight: h }).catch(() => {});
  }, []);

  return (
    <div className="app">
      <TitleBar onOpenSettings={() => setSettingsOpen(true)} onToggleTerminal={() => setDrawerOpen((o) => !o)} terminalOpen={drawerOpen} />
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
        appWorkDir={appWorkDir}
        terminalsByCwd={terminalsByCwd}
        onNewTerminalInAppWorkDir={handleNewTerminalInAppWorkDir}
        onNewTerminalInCwd={handleNewTerminalInCwd}
      />
      <FilePanel
        addedDirs={Array.from(visibleDirs)}
        activeCwd={activeCwd}
        onOpenFile={handleOpenFile}
        width={filePanelWidth}
        onResize={handleFilePanelResize}
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
        {drawerOpen && (
          <TerminalDrawer
            open={drawerOpen}
            height={drawerHeight}
            tabs={terminals.map((t) => ({ id: t.id, title: t.title }))}
            activeId={activeTermId}
            onSelectTab={setActiveTermId}
            onCloseTab={handleCloseTab}
            onNewTerminal={handleNewTerminal}
            onResizeHeight={handleResizeDrawer}
          />
        )}
      </main>
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
      <FileDrawer file={drawerFile} onClose={() => setDrawerFile(null)} onOpenFile={handleOpenFile} />
    </div>
  );
}
