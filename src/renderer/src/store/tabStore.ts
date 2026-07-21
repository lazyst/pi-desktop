// 统一 Tab store（按工作目录分组）
//
// 每个工作目录（cwd）拥有独立的 tab 条，切换目录时保留各自 tab 列表和激活状态。
// 所有 tab 仍存放在单一扁平数组中，通过 cwd/root 字段确定所属分组。
// activeCwd 指示当前显示哪个目录的 tab 条，cwdActiveTab 记忆各目录最后激活的 tab。

import { create } from 'zustand';
import type { IntegratedTerminalInfo } from '../types';
import { capturePaneScrollState } from '../components/paneManager';

/** Tab 内容类型。 */
export type TabKind = 'session' | 'preview' | 'diff' | 'integrated-terminal';

/** Tab 落点区域：统一为 'editor'（抽屉已移除）。 */
export type TabLocation = 'editor';

/** 通用 Tab 基础字段。 */
export interface BaseTab {
  id: string;
  kind: TabKind;
  location: TabLocation;
  title: string;
  /** keep-alive：true 时不卸载内容实例、仅在 tab 条隐藏。 */
  hidden: boolean;
  /** 排序序号，驱动拖拽重排。 */
  order: number;
}

export interface SessionTab extends BaseTab {
  kind: 'session';
  location: 'editor';
  key: string;
  cwd: string;
  name: string;
}

export interface PreviewTab extends BaseTab {
  kind: 'preview';
  location: 'editor';
  root: string;
  path: string;
}

export interface DiffTab extends BaseTab {
  kind: 'diff';
  location: 'editor';
  cwd: string;
  commitHash: string | null;
}

export interface IntegratedTerminalTab extends BaseTab {
  kind: 'integrated-terminal';
  location: 'editor';
  cwd: string;
}

export type Tab = SessionTab | PreviewTab | DiffTab | IntegratedTerminalTab;

/** 取 tab 所属的工作目录（cwd）。preview 的 cwd 是 root，其余直接用 cwd 字段。 */
export function getTabCwd(tab: Tab): string {
  switch (tab.kind) {
    case 'session':
    case 'integrated-terminal':
    case 'diff':
      return tab.cwd;
    case 'preview':
      return tab.root;
  }
}

/** 过滤出属于指定 cwd 的可见 tab（按 order 排序）。 */
export function cwdVisibleTabs(tabs: Tab[], cwd: string): Tab[] {
  return tabs
    .filter((t) => !t.hidden && getTabCwd(t) === cwd)
    .sort((a, b) => a.order - b.order);
}

export interface TabStore {
  // —— 状态 ——
  tabs: Tab[];
  activeTabId: string | null;
  /** 当前显示哪个工作目录的 tab 条。 */
  activeCwd: string | null;
  /** 有 tab 的工作目录列表（保持首次出现顺序）。 */
  cwdOrder: string[];
  /** 各目录最后激活的 tab id（切换回该目录时恢复）。 */
  cwdActiveTab: Record<string, string | null>;
  /** 主进程推送的终端实例列表（供侧边栏分组计数）。 */
  terminals: IntegratedTerminalInfo[];

  // —— action ——
  /** 切换到指定工作目录的 tab 条，记住当前目录的激活 tab，恢复目标目录的上次激活 tab。 */
  setActiveCwd: (cwd: string) => void;
  openSession: (req: { key?: string; cwd?: string; name?: string }) => void;
  openPreview: (root: string, path: string, fileName?: string) => void;
  openDiff: (cwd: string, commitHash: string | null) => void;
  openTerminal: (id: string, cwd: string, title: string) => void;
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  hideTab: (id: string) => void;
  reorderTabs: (orderedIds: string[]) => void;
  setHidden: (id: string, hidden: boolean) => void;
  /** 主进程 onTerminalList 推送的完整实例列表写回。 */
  setTerminals: (list: IntegratedTerminalInfo[]) => void;
  /** 主进程 onExit 推送：移除所有 kind==='session' 且 key 匹配的 tab。 */
  removeSessionTab: (key: string) => void;
  /** 主进程 onTerminalExit 推送：移除 kind==='integrated-terminal' 且 id 匹配的 tab。 */
  removeTerminalTab: (id: string) => void;
  /** TabBar × 统一关闭入口：
   *  session / integrated-terminal → 仅隐藏不卸载（keep-alive）；
   *  preview / diff → 真移除。 */
  closeCenterTab: (id: string) => void;
  /** 把已晋升 live 会话的标题同步为磁盘真实名称。 */
  promoteTabNames: (diskList: { key: string; name: string }[]) => void;
}

/** 为新增 tab 计算下一个 order。 */
function nextOrder(tabs: Tab[]): number {
  if (tabs.length === 0) return 0;
  return tabs.reduce((max, t) => Math.max(max, t.order), -1) + 1;
}

/** 在 tabs 中找指定 cwd 下第一个可见 tab；无则返回 null。 */
function firstVisibleInCwd(tabs: Tab[], cwd: string): string | null {
  const t = tabs.find((t) => !t.hidden && getTabCwd(t) === cwd);
  return t ? t.id : null;
}

/**
 * 更新 cwdActiveTab 的工具函数。
 * 先安全复制，清除旧值为无效 id 的条目（已被删除的 tab），再设置新值。
 */
function updateCwdActiveTab(
  prev: Record<string, string | null>,
  tabs: Tab[],
  cwd: string,
  tabId: string | null,
): Record<string, string | null> {
  const next: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(prev)) {
    // 只保留仍存在的 tab id
    if (v !== null && tabs.some((t) => t.id === v)) {
      next[k] = v;
    }
  }
  next[cwd] = tabId;
  return next;
}

/** 把 cwd 加入 cwdOrder（若还不存在）。 */
function ensureCwdOrder(order: string[], cwd: string): string[] {
  return order.includes(cwd) ? order : [...order, cwd];
}

/**
 * 保存当前 activeCwd 下所有终端 pane 的滚动位置（对齐 Orca captureScrollState）。
 * 在所有改变 activeCwd 的 action 中调用，确保在 DOM 更新前完成。
 */
function captureOldCwdScrollStates(tabs: Tab[], activeCwd: string | null): void {
  if (!activeCwd) return;
  for (const t of tabs) {
    const tCwd = t.kind === 'preview' ? t.root : (t as any).cwd;
    if (tCwd !== activeCwd) continue;
    if (t.kind !== 'session' && t.kind !== 'integrated-terminal') continue;
    capturePaneScrollState(t.id);
  }
}

export const useTabStore = create<TabStore>((set) => ({
  tabs: [],
  activeTabId: null,
  activeCwd: null,
  cwdOrder: [],
  cwdActiveTab: {},
  terminals: [],

  setActiveCwd: (cwd: string) =>
    set((state) => {
      if (state.activeCwd === cwd) return {};
      // 关键：在 DOM 更新前保存当前目录所有终端 pane 的滚动位置（对齐 Orca captureScrollState）。
      captureOldCwdScrollStates(state.tabs, state.activeCwd);
      // 保存当前目录的激活 tab
      const cwdActiveTab = { ...state.cwdActiveTab };
      if (state.activeCwd != null) {
        cwdActiveTab[state.activeCwd] = state.activeTabId;
      }
      // 恢复目标目录的上次激活 tab；若已失效则置 null
      let activeTabId = cwdActiveTab[cwd] ?? null;
      if (activeTabId != null && !state.tabs.some((t) => t.id === activeTabId)) {
        activeTabId = null;
        cwdActiveTab[cwd] = null;
      }
      return {
        activeCwd: cwd,
        activeTabId,
        cwdActiveTab,
        cwdOrder: ensureCwdOrder(state.cwdOrder, cwd),
      };
    }),

  openSession: ({ key, cwd = '', name = '' }) =>
    set((state) => {
      const cwdVal = cwd || key || '';
      if (cwdVal !== state.activeCwd) captureOldCwdScrollStates(state.tabs, state.activeCwd);
      const id = key ?? cwdVal;
      const existing = state.tabs.find(
        (t) => t.kind === 'session' && (t as SessionTab).key === id,
      );
      let tabs: Tab[];
      let newActiveTabId: string;
      if (existing) {
        tabs = state.tabs.map((t) =>
          t.id === existing.id ? { ...t, hidden: false } : t,
        );
        newActiveTabId = existing.id;
      } else {
        const tab: SessionTab = {
          id,
          kind: 'session',
          location: 'editor',
          title: name || id,
          hidden: false,
          order: nextOrder(state.tabs),
          key: id,
          cwd: cwdVal,
          name: name || id,
        };
        tabs = [...state.tabs, tab];
        newActiveTabId = id;
      }
      return {
        tabs,
        activeTabId: newActiveTabId,
        activeCwd: cwdVal,
        cwdActiveTab: updateCwdActiveTab(state.cwdActiveTab, tabs, cwdVal, newActiveTabId),
        cwdOrder: ensureCwdOrder(state.cwdOrder, cwdVal),
      };
    }),

  openPreview: (root, path, fileName) =>
    set((state) => {
      if (root !== state.activeCwd) captureOldCwdScrollStates(state.tabs, state.activeCwd);
      const id = `preview:${root}//${path}`;
      const existing = state.tabs.find((t) => t.kind === 'preview' && t.id === id);
      let tabs: Tab[];
      let newActiveTabId: string;
      if (existing) {
        tabs = state.tabs.map((t) =>
          t.id === id ? { ...t, hidden: false } : t,
        );
        newActiveTabId = id;
      } else {
        const tab: PreviewTab = {
          id,
          kind: 'preview',
          location: 'editor',
          title: fileName || path.split('/').pop() || path,
          hidden: false,
          order: nextOrder(state.tabs),
          root,
          path,
        };
        tabs = [...state.tabs, tab];
        newActiveTabId = id;
      }
      return {
        tabs,
        activeTabId: newActiveTabId,
        activeCwd: root,
        cwdActiveTab: updateCwdActiveTab(state.cwdActiveTab, tabs, root, newActiveTabId),
        cwdOrder: ensureCwdOrder(state.cwdOrder, root),
      };
    }),

  openDiff: (cwd, commitHash) =>
    set((state) => {
      if (cwd !== state.activeCwd) captureOldCwdScrollStates(state.tabs, state.activeCwd);
      const id = `diff:${cwd}//${commitHash ?? 'work'}`;
      const existing = state.tabs.find((t) => t.kind === 'diff' && t.id === id);
      let tabs: Tab[];
      let newActiveTabId: string;
      if (existing) {
        tabs = state.tabs.map((t) =>
          t.id === id ? { ...t, hidden: false } : t,
        );
        newActiveTabId = id;
      } else {
        const tab: DiffTab = {
          id,
          kind: 'diff',
          location: 'editor',
          title: commitHash ? commitHash.slice(0, 8) : '工作区改动',
          hidden: false,
          order: nextOrder(state.tabs),
          cwd,
          commitHash,
        };
        tabs = [...state.tabs, tab];
        newActiveTabId = id;
      }
      return {
        tabs,
        activeTabId: newActiveTabId,
        activeCwd: cwd,
        cwdActiveTab: updateCwdActiveTab(state.cwdActiveTab, tabs, cwd, newActiveTabId),
        cwdOrder: ensureCwdOrder(state.cwdOrder, cwd),
      };
    }),

  openTerminal: (id, cwd, title) =>
    set((state) => {
      if (cwd !== state.activeCwd) captureOldCwdScrollStates(state.tabs, state.activeCwd);
      const existing = state.tabs.find((t) => t.id === id);
      let tabs: Tab[];
      let newActiveTabId: string;
      if (existing) {
        tabs = state.tabs.map((t) =>
          t.id === id ? { ...t, hidden: false } : t,
        );
        newActiveTabId = id;
      } else {
        const tab: IntegratedTerminalTab = {
          id,
          kind: 'integrated-terminal',
          location: 'editor',
          title,
          hidden: false,
          order: nextOrder(state.tabs),
          cwd,
        };
        tabs = [...state.tabs, tab];
        newActiveTabId = id;
      }
      return {
        tabs,
        activeTabId: newActiveTabId,
        activeCwd: cwd,
        cwdActiveTab: updateCwdActiveTab(state.cwdActiveTab, tabs, cwd, newActiveTabId),
        cwdOrder: ensureCwdOrder(state.cwdOrder, cwd),
      };
    }),

  selectTab: (id) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return {};
      const tabCwd = getTabCwd(tab);
      // 切换到不同目录时，先保存旧目录的滚动位置
      if (tabCwd !== state.activeCwd) captureOldCwdScrollStates(state.tabs, state.activeCwd);
      return {
        activeTabId: id,
        activeCwd: tabCwd,
        cwdActiveTab: updateCwdActiveTab(state.cwdActiveTab, state.tabs, tabCwd, id),
        cwdOrder: ensureCwdOrder(state.cwdOrder, tabCwd),
      };
    }),

  closeTab: (id) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return {};
      const tabCwd = getTabCwd(tab);
      const remaining = state.tabs.filter((t) => t.id !== id);
      const patch: Partial<TabStore> = { tabs: remaining };

      if (state.activeTabId === id) {
        // 关闭的是当前激活 tab → 在同目录找下一个可见 tab
        const nextId = firstVisibleInCwd(remaining, state.activeCwd ?? tabCwd);
        patch.activeTabId = nextId;
        if (state.activeCwd) {
          patch.cwdActiveTab = updateCwdActiveTab(
            state.cwdActiveTab,
            remaining,
            state.activeCwd,
            nextId,
          );
        }
      } else if (state.cwdActiveTab[tabCwd] === id) {
        // 关闭的是某目录记忆的激活 tab（非当前）→ 更新该目录的记忆
        const nextId = firstVisibleInCwd(remaining, tabCwd);
        patch.cwdActiveTab = updateCwdActiveTab(
          state.cwdActiveTab,
          remaining,
          tabCwd,
          nextId,
        );
      }
      return patch;
    }),

  hideTab: (id) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return {};
      const tabCwd = getTabCwd(tab);
      const tabs = state.tabs.map((t) => (t.id === id ? { ...t, hidden: true } : t));
      const patch: Partial<TabStore> = { tabs };
      if (state.activeTabId === id) {
        const nextId = firstVisibleInCwd(tabs, state.activeCwd ?? tabCwd);
        patch.activeTabId = nextId;
        if (state.activeCwd) {
          patch.cwdActiveTab = updateCwdActiveTab(
            state.cwdActiveTab,
            tabs,
            state.activeCwd,
            nextId,
          );
        }
      }
      return patch;
    }),

  setHidden: (id, hidden) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab || tab.hidden === hidden) return {};
      const tabs = state.tabs.map((t) => (t.id === id ? { ...t, hidden } : t));
      const patch: Partial<TabStore> = { tabs };
      if (!hidden && state.activeTabId === null) {
        // 取消隐藏且当前无激活 → 激活它
        patch.activeTabId = id;
        if (state.activeCwd) {
          patch.cwdActiveTab = updateCwdActiveTab(
            state.cwdActiveTab,
            tabs,
            state.activeCwd,
            id,
          );
        }
      } else if (hidden && state.activeTabId === id) {
        // 隐藏当前激活 tab → 在同目录找下一个
        const nextId = firstVisibleInCwd(tabs, state.activeCwd ?? getTabCwd(tab));
        patch.activeTabId = nextId;
        if (state.activeCwd) {
          patch.cwdActiveTab = updateCwdActiveTab(
            state.cwdActiveTab,
            tabs,
            state.activeCwd,
            nextId,
          );
        }
      }
      return patch;
    }),

  reorderTabs: (orderedIds) =>
    set((state) => {
      const orderMap = new Map<string, number>();
      orderedIds.forEach((id, idx) => orderMap.set(id, idx));
      const tabs = state.tabs.map((t) => {
        if (orderMap.has(t.id)) return { ...t, order: orderMap.get(t.id)! };
        return t;
      });
      return { tabs };
    }),

  setTerminals: (list) => set({ terminals: list }),

  removeSessionTab: (key) =>
    set((state) => {
      const removed = state.tabs.find(
        (t) => t.kind === 'session' && (t as SessionTab).key === key,
      );
      const remaining = state.tabs.filter(
        (t) => !(t.kind === 'session' && (t as SessionTab).key === key),
      );
      if (remaining.length === state.tabs.length) return {};
      const patch: Partial<TabStore> = { tabs: remaining };
      if (state.activeTabId && !remaining.some((t) => t.id === state.activeTabId)) {
        const nextId = firstVisibleInCwd(remaining, state.activeCwd ?? '');
        patch.activeTabId = nextId;
        if (state.activeCwd) {
          patch.cwdActiveTab = updateCwdActiveTab(
            state.cwdActiveTab,
            remaining,
            state.activeCwd,
            nextId,
          );
        }
      } else if (removed && state.cwdActiveTab[getTabCwd(removed)] === removed.id) {
        const cwd = getTabCwd(removed);
        const nextId = firstVisibleInCwd(remaining, cwd);
        patch.cwdActiveTab = updateCwdActiveTab(state.cwdActiveTab, remaining, cwd, nextId);
      }
      return patch;
    }),

  removeTerminalTab: (id) =>
    set((state) => {
      const removed = state.tabs.find(
        (t) => t.kind === 'integrated-terminal' && t.id === id,
      );
      const remaining = state.tabs.filter(
        (t) => !(t.kind === 'integrated-terminal' && t.id === id),
      );
      if (remaining.length === state.tabs.length) return {};
      const patch: Partial<TabStore> = { tabs: remaining };
      if (state.activeTabId === id) {
        const nextId = firstVisibleInCwd(remaining, state.activeCwd ?? '');
        patch.activeTabId = nextId;
        if (state.activeCwd) {
          patch.cwdActiveTab = updateCwdActiveTab(
            state.cwdActiveTab,
            remaining,
            state.activeCwd,
            nextId,
          );
        }
      } else if (removed && state.cwdActiveTab[getTabCwd(removed)] === removed.id) {
        const cwd = getTabCwd(removed);
        const nextId = firstVisibleInCwd(remaining, cwd);
        patch.cwdActiveTab = updateCwdActiveTab(state.cwdActiveTab, remaining, cwd, nextId);
      }
      return patch;
    }),

  closeCenterTab: (id) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return {};
      const tabCwd = getTabCwd(tab);
      // session / integrated-terminal 终端：keep-alive，仅隐藏不卸载。
      if (tab.kind === 'session' || tab.kind === 'integrated-terminal') {
        if (state.tabs.some((t) => t.id === id && t.hidden)) return {};
        const tabs = state.tabs.map((t) => (t.id === id ? { ...t, hidden: true } : t));
        const patch: Partial<TabStore> = { tabs };
        if (state.activeTabId === id) {
          const nextId = firstVisibleInCwd(tabs, state.activeCwd ?? tabCwd);
          patch.activeTabId = nextId;
          if (state.activeCwd) {
            patch.cwdActiveTab = updateCwdActiveTab(
              state.cwdActiveTab,
              tabs,
              state.activeCwd,
              nextId,
            );
          }
        }
        return patch;
      }
      // preview / diff：真移除。
      const remaining = state.tabs.filter((t) => t.id !== id);
      const patch: Partial<TabStore> = { tabs: remaining };
      if (state.activeTabId === id) {
        const nextId = firstVisibleInCwd(remaining, state.activeCwd ?? tabCwd);
        patch.activeTabId = nextId;
        if (state.activeCwd) {
          patch.cwdActiveTab = updateCwdActiveTab(
            state.cwdActiveTab,
            remaining,
            state.activeCwd,
            nextId,
          );
        }
      } else if (state.cwdActiveTab[tabCwd] === id) {
        const nextId = firstVisibleInCwd(remaining, tabCwd);
        patch.cwdActiveTab = updateCwdActiveTab(state.cwdActiveTab, remaining, tabCwd, nextId);
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
