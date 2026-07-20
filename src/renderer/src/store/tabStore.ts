// 统一 Tab store 骨架（ADR-0001 决策②：zustand 作全局 tab store）。
//
// 本文件是阶段1 的核心状态容器：已实现全部 action（见 issue 02）。store 仅作为
// 状态容器，主进程 SessionPool / IntegratedTerminalPool 的调用点暂不动，组件接入
// （阶段1 后续）时直接消费此处状态即可。

import { create } from 'zustand';

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

  // —— action ——
  openSession: (req: { key?: string; cwd?: string; name?: string }) => void;
  openPreview: (root: string, path: string) => void;
  openDiff: (cwd: string, commitHash: string | null) => void;
  openTerminal: (cwd: string) => void;
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  hideTab: (id: string) => void;
  reorderTabs: (location: TabLocation, orderedIds: string[]) => void;
  setHidden: (id: string, hidden: boolean) => void;
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

  openPreview: (root, path) =>
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
        title: path,
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
        title: commitHash ? `Diff ${commitHash.slice(0, 7)}` : 'Working Tree',
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
}));
