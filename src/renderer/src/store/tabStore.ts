// 统一 Tab store 骨架（ADR-0001 决策②：zustand 作全局 tab store）。
//
// 本文件是阶段1 的核心状态容器：已实现全部 action（见 issue 02）。store 仅作为
// 状态容器，主进程 SessionPool / IntegratedTerminalPool 的调用点暂不动，组件接入
// （阶段1 后续）时直接消费此处状态即可。

import { create } from 'zustand';
import type { IntegratedTerminalInfo } from '../types';
// 抽屉高度默认值取自主进程 config（defaultConfig），与重构前 App 的
// useState(defaultConfig().terminalDrawerHeight) 行为一致（见 issue 03）。
import { defaultConfig } from '../../../main/config';

/** Tab 内容类型（对齐 CONTEXT.md TabKind）。 */
export type TabKind = 'session' | 'preview' | 'diff' | 'integrated-terminal';

/** Tab 落点区域（对齐 CONTEXT.md TabLocation）。 */
export type TabLocation = 'editor' | 'panel' | 'floating';

/** 通用 Tab 基础字段（统一模型，由 kind/location 区分用途）。 */
export interface BaseTab {
  id: string; // 唯一 id（session 用 key；preview 用 `preview:${root}//${path}`；diff 用 `diff:${cwd}//${commitHash ?? 'work'}`；integrated-terminal 用终端 id）
  kind: TabKind;
  location: TabLocation; // 落点区域
  title: string; // Tab 条显示的标题
  /** keep-alive：true 时不卸载内容实例、仅在 tab 条隐藏（对齐 VS Code setVisible 不析构语义）。 */
  hidden: boolean;
  /** 在所属 location 内的排序序号，驱动拖拽重排（TabReorder）。 */
  order: number;
}

export interface SessionTab extends BaseTab {
  kind: 'session';
  location: 'editor';
  key: string; // sessionKey（.jsonl 绝对路径 / live-<uuid>）
  cwd: string;
  name: string;
}

export interface PreviewTab extends BaseTab {
  kind: 'preview';
  location: 'editor';
  root: string; // 仓库根目录
  path: string; // 相对 root 的文件路径
}

export interface DiffTab extends BaseTab {
  kind: 'diff';
  location: 'editor';
  cwd: string;
  commitHash: string | null; // null = 工作区 diff
}

export interface IntegratedTerminalTab extends BaseTab {
  kind: 'integrated-terminal';
  location: 'panel';
  cwd: string;
}

export type Tab = SessionTab | PreviewTab | DiffTab | IntegratedTerminalTab;

/** 各 location 当前可见（未 hidden）的 tab 列表。 */
export function visibleTabsByLocation(tabs: Tab[], location: TabLocation): Tab[] {
  return tabs
    .filter((t) => t.location === location && !t.hidden)
    .sort((a, b) => a.order - b.order);
}

/** 取某 location 下下一个应激活的 tab id：在同 location 的可见 tab 中顺序取第一个，否则 null。 */
export function nextActiveIdInLocation(tabs: Tab[], location: TabLocation, excludeId: string): string | null {
  const visible = visibleTabsByLocation(tabs, location).filter((t) => t.id !== excludeId);
  return visible.length ? visible[0].id : null;
}

export interface TabStore {
  // —— 状态 ——
  tabs: Tab[];
  activeEditorTabId: string | null; // 中间区（editor）激活 tab
  activePanelTabId: string | null; // 底部终端区（panel）激活 tab

  // —— 集成终端抽屉状态（阶段1 后续从 App 收编，见 issue 03） ——
  // 终端抽屉的实例列表 / 开关 / 高度 / 当前激活终端，统一由 store 持有，
  // App 仅把主进程推送（onTerminalList / onTerminalExit）写回此处，组件直接订阅。
  terminals: IntegratedTerminalInfo[]; // 主进程经 onTerminalList 主动推送的完整实例列表
  drawerOpen: boolean; // 抽屉是否展开
  drawerHeight: number; // 抽屉高度（像素），持久化于 config.terminalDrawerHeight
  activeTermId: string | null; // 当前激活的集成终端 tab id

  // —— action ——
  openSession: (req: { key?: string; cwd?: string; name?: string }) => void;
  openPreview: (root: string, path: string, fileName?: string) => void;
  openDiff: (cwd: string, commitHash: string | null) => void;
  openTerminal: (cwd: string) => void;
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  hideTab: (id: string) => void;
  reorderTabs: (location: TabLocation, orderedIds: string[]) => void;
  setHidden: (id: string, hidden: boolean) => void;

  // —— 集成终端抽屉 action（issue 03） ——
  /** 主进程 onTerminalList 推送的完整实例列表写回（单一事实来源）。 */
  setTerminals: (list: IntegratedTerminalInfo[]) => void;
  /** 切换 / 设置抽屉展开态（TitleBar 终端按钮调 toggleDrawer）。 */
  toggleDrawer: () => void;
  setDrawerOpen: (open: boolean) => void;
  /** 设置抽屉高度（拖拽或初始化时）。注意：持久化（setConfig）由 App 负责，此处只管状态。 */
  setDrawerHeight: (h: number) => void;
  /** 设置当前激活集成终端 tab（用户点选 / 新建后置位）。 */
  setActiveTermId: (id: string | null) => void;
  /** 主进程 onTerminalExit 推送：移除对应终端 tab，若其为激活态则切到剩余第一个或 null。 */
  removeTerminal: (id: string) => void;
  /** 主进程 onExit 推送：移除所有 kind==='session' 且 key 匹配的 tab（含已隐藏 keep-alive 的）。 */
  removeSessionTab: (key: string) => void;
  /** 中间区 tab 关闭统一入口（TabBar × 经 guard 后调用）：
   *  session 终端 → 仅隐藏不卸载（keep-alive，对齐 hideTab），从侧边栏重开即恢复；
   *  preview / diff → 真移除（无 keep-alive 需求）。若关掉的是激活态则切到下一个可见 tab。 */
  closeCenterTab: (id: string) => void;
  /** 主进程 onIndex 推送：把已晋升 live 会话在 tabs 中的标题同步为磁盘真实名称
   *  （首条用户消息），使终端标题从 “new-session” 更新为实际会话名。仅改 session tab。 */
  promoteTabNames: (diskList: { key: string; name: string }[]) => void;
}

/** 同 location 内为新增 tab 计算下一个 order（当前最大 order + 1）。 */
function nextOrder(tabs: Tab[], location: TabLocation): number {
  const inLoc = tabs.filter((t) => t.location === location);
  if (inLoc.length === 0) return 0;
  return inLoc.reduce((max, t) => Math.max(max, t.order), -1) + 1;
}

/** 在某 location 的可见 tab 里找第一个作为激活候选。 */
function firstVisibleId(tabs: Tab[], location: TabLocation): string | null {
  const visible = visibleTabsByLocation(tabs, location);
  return visible.length ? visible[0].id : null;
}

export const useTabStore = create<TabStore>((set) => ({
  tabs: [],
  activeEditorTabId: null,
  activePanelTabId: null,

  // —— 集成终端抽屉初始状态 ——
  terminals: [],
  drawerOpen: false,
  drawerHeight: defaultConfig().terminalDrawerHeight, // 默认值（config 异步加载后由 App 覆盖）
  activeTermId: null,

  openSession: ({ key, cwd = '', name = '' }) =>
    set((state) => {
      // key 缺失时回退到 cwd（与 App 行为对齐：sessionKey 优先，否则用 cwd 标识唯一会话）。
      const id = key ?? cwd;
      const existing = state.tabs.find((t) => t.kind === 'session' && t.key === id);
      if (existing) {
        // 已存在（可见或已隐藏）：取消隐藏并激活。
        return {
          tabs: state.tabs.map((t) =>
            t.id === existing.id ? { ...t, hidden: false } : t,
          ),
          activeEditorTabId: existing.id,
        };
      }
      const tab: SessionTab = {
        id,
        kind: 'session',
        location: 'editor',
        title: name || id,
        hidden: false,
        order: nextOrder(state.tabs, 'editor'),
        key: id,
        cwd,
        name: name || id,
      };
      return {
        tabs: [...state.tabs, tab],
        activeEditorTabId: id,
      };
    }),

  openPreview: (root, path, fileName) =>
    set((state) => {
      const id = `preview:${root}//${path}`;
      const existing = state.tabs.find((t) => t.kind === 'preview' && t.id === id);
      if (existing) {
        return {
          tabs: state.tabs.map((t) =>
            t.id === id ? { ...t, hidden: false } : t,
          ),
          activeEditorTabId: id,
        };
      }
      const tab: PreviewTab = {
        id,
        kind: 'preview',
        location: 'editor',
        // 标题优先用文件树传入的文件名，否则取 path 末段（对齐 App 原 handleOpenFile 行为）。
        title: fileName || path.split('/').pop() || path,
        hidden: false,
        order: nextOrder(state.tabs, 'editor'),
        root,
        path,
      };
      return {
        tabs: [...state.tabs, tab],
        activeEditorTabId: id,
      };
    }),

  openDiff: (cwd, commitHash) =>
    set((state) => {
      const id = `diff:${cwd}//${commitHash ?? 'work'}`;
      const existing = state.tabs.find((t) => t.kind === 'diff' && t.id === id);
      if (existing) {
        return {
          tabs: state.tabs.map((t) =>
            t.id === id ? { ...t, hidden: false } : t,
          ),
          activeEditorTabId: id,
        };
      }
      const tab: DiffTab = {
        id,
        kind: 'diff',
        location: 'editor',
        title: commitHash ? commitHash.slice(0, 8) : '工作区改动',
        hidden: false,
        order: nextOrder(state.tabs, 'editor'),
        cwd,
        commitHash,
      };
      return {
        tabs: [...state.tabs, tab],
        activeEditorTabId: id,
      };
    }),

  openTerminal: (cwd) =>
    set((state) => {
      // 集成终端按 cwd 去重：同 cwd 已存在则激活，不重复创建。
      const existing = state.tabs.find(
        (t) => t.kind === 'integrated-terminal' && t.location === 'panel' && (t as IntegratedTerminalTab).cwd === cwd,
      );
      if (existing) {
        return {
          tabs: state.tabs.map((t) =>
            t.id === existing.id ? { ...t, hidden: false } : t,
          ),
          activePanelTabId: existing.id,
        };
      }
      const id = `terminal:${cwd}`;
      const tab: IntegratedTerminalTab = {
        id,
        kind: 'integrated-terminal',
        location: 'panel',
        title: cwd,
        hidden: false,
        order: nextOrder(state.tabs, 'panel'),
        cwd,
      };
      return {
        tabs: [...state.tabs, tab],
        activePanelTabId: id,
      };
    }),

  selectTab: (id) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return {};
      if (tab.location === 'editor') {
        return { activeEditorTabId: id };
      }
      if (tab.location === 'panel') {
        return { activePanelTabId: id };
      }
      return {};
    }),

  closeTab: (id) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return {};
      const remaining = state.tabs.filter((t) => t.id !== id);
      // 移除后，若该 tab 原本是所在 location 的激活项，激活候选回退到同 location 下一个可见 tab。
      const patch: Partial<TabStore> = { tabs: remaining };
      if (tab.location === 'editor' && state.activeEditorTabId === id) {
        patch.activeEditorTabId = firstVisibleId(remaining, 'editor');
      }
      if (tab.location === 'panel' && state.activePanelTabId === id) {
        patch.activePanelTabId = firstVisibleId(remaining, 'panel');
      }
      return patch;
    }),

  hideTab: (id) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return {};
      const tabs = state.tabs.map((t) => (t.id === id ? { ...t, hidden: true } : t));
      // 隐藏后若仍是激活项，把激活态切到同 location 下一个可见 tab（keep-alive，不卸载）。
      const patch: Partial<TabStore> = { tabs };
      if (tab.location === 'editor' && state.activeEditorTabId === id) {
        patch.activeEditorTabId = nextActiveIdInLocation(tabs, 'editor', id);
      }
      if (tab.location === 'panel' && state.activePanelTabId === id) {
        patch.activePanelTabId = nextActiveIdInLocation(tabs, 'panel', id);
      }
      return patch;
    }),

  setHidden: (id, hidden) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return {};
      if (tab.hidden === hidden) return {};
      const tabs = state.tabs.map((t) => (t.id === id ? { ...t, hidden } : t));
      // 取消隐藏时若所在 location 无激活项，则激活它；隐藏时若仍是激活项则回退。
      const patch: Partial<TabStore> = { tabs };
      if (tab.location === 'editor') {
        if (!hidden && state.activeEditorTabId === null) {
          patch.activeEditorTabId = id;
        } else if (hidden && state.activeEditorTabId === id) {
          patch.activeEditorTabId = nextActiveIdInLocation(tabs, 'editor', id);
        }
      }
      if (tab.location === 'panel') {
        if (!hidden && state.activePanelTabId === null) {
          patch.activePanelTabId = id;
        } else if (hidden && state.activePanelTabId === id) {
          patch.activePanelTabId = nextActiveIdInLocation(tabs, 'panel', id);
        }
      }
      return patch;
    }),

  reorderTabs: (location, orderedIds) =>
    set((state) => {
      // 仅对属于该 location 的 id 按传入顺序重排 order；传入顺序外的同 location tab 保持原 order。
      const orderMap = new Map<string, number>();
      orderedIds.forEach((id, idx) => orderMap.set(id, idx));
      const tabs = state.tabs.map((t) => {
        if (t.location !== location) return t;
        if (orderMap.has(t.id)) {
          return { ...t, order: orderMap.get(t.id)! };
        }
        return t;
      });
      return { tabs };
    }),

  // —— 集成终端抽屉 action ——
  setTerminals: (list) =>
    set({ terminals: list }),

  toggleDrawer: () =>
    set((state) => ({ drawerOpen: !state.drawerOpen })),

  setDrawerOpen: (open) =>
    set({ drawerOpen: open }),

  setDrawerHeight: (h) =>
    set({ drawerHeight: h }),

  setActiveTermId: (id) =>
    set({ activeTermId: id }),

  removeTerminal: (id) =>
    set((state) => {
      const remaining = state.terminals.filter((t) => t.id !== id);
      const patch: Partial<TabStore> = { terminals: remaining };
      if (state.activeTermId === id) {
        patch.activeTermId = remaining.length ? remaining[0].id : null;
      }
      return patch;
    }),

  removeSessionTab: (key) =>
    set((state) => {
      const remaining = state.tabs.filter(
        (t) => !(t.kind === 'session' && (t as SessionTab).key === key),
      );
      if (remaining.length === state.tabs.length) return {};
      const patch: Partial<TabStore> = { tabs: remaining };
      // 若被移除的 session 是当前激活 editor tab，回退到下一个可见 editor tab。
      if (
        state.activeEditorTabId &&
        state.tabs.some(
          (t) => t.id === state.activeEditorTabId && t.kind === 'session' && (t as SessionTab).key === key,
        )
      ) {
        patch.activeEditorTabId = firstVisibleId(remaining, 'editor');
      }
      return patch;
    }),

  closeCenterTab: (id) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return {};
      // session 终端：keep-alive，仅隐藏不卸载（对齐 hideTab 语义）。
      if (tab.kind === 'session') {
        return state.tabs.some((t) => t.id === id && t.hidden)
          ? {}
          : { tabs: state.tabs.map((t) => (t.id === id ? { ...t, hidden: true } : t)) };
      }
      // preview / diff：真移除（closeTab 语义）。
      const remaining = state.tabs.filter((t) => t.id !== id);
      const patch: Partial<TabStore> = { tabs: remaining };
      if (tab.location === 'editor' && state.activeEditorTabId === id) {
        patch.activeEditorTabId = firstVisibleId(remaining, 'editor');
      }
      return patch;
    }),

  promoteTabNames: (diskList) =>
    set((state) => {
      let changed = false;
      const tabs = state.tabs.map((t) => {
        if (t.kind !== 'session') return t;
        const d = diskList.find((x) => x.key === (t as SessionTab).key);
        if (d && d.name && d.name !== t.name) {
          changed = true;
          return { ...t, name: d.name, title: d.name };
        }
        return t;
      });
      return changed ? { tabs } : {};
    }),
}));
