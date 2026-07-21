// 统一 Tab store（Phase 2 — 终端统一，去掉抽屉和双 location）。
//
// 所有 tab（session / preview / diff / terminal）共享同一 location 'editor'，
// 在统一 TabBar 中展示。终端抽屉状态（drawerOpen/drawerHeight）已移除。
// 激活 ID 统一为 activeTabId（替代旧的 activeEditorTabId + activePanelTabId）。

import { create } from 'zustand';
import type { IntegratedTerminalInfo } from '../types';

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

/** 当前可见（未 hidden）的 tab 列表。 */
export function visibleTabs(tabs: Tab[]): Tab[] {
  return tabs.filter((t) => !t.hidden).sort((a, b) => a.order - b.order);
}

export interface TabStore {
  // —— 状态 ——
  tabs: Tab[];
  activeTabId: string | null;
  /** 主进程推送的终端实例列表（供侧边栏分组计数）。 */
  terminals: IntegratedTerminalInfo[];

  // —— action ——
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

export const useTabStore = create<TabStore>((set) => ({
  tabs: [],
  activeTabId: null,
  terminals: [],

  openSession: ({ key, cwd = '', name = '' }) =>
    set((state) => {
      const id = key ?? cwd;
      const existing = state.tabs.find((t) => t.kind === 'session' && (t as SessionTab).key === id);
      if (existing) {
        return {
          tabs: state.tabs.map((t) =>
            t.id === existing.id ? { ...t, hidden: false } : t,
          ),
          activeTabId: existing.id,
        };
      }
      const tab: SessionTab = {
        id,
        kind: 'session',
        location: 'editor',
        title: name || id,
        hidden: false,
        order: nextOrder(state.tabs),
        key: id,
        cwd,
        name: name || id,
      };
      return { tabs: [...state.tabs, tab], activeTabId: id };
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
          activeTabId: id,
        };
      }
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
      return { tabs: [...state.tabs, tab], activeTabId: id };
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
          activeTabId: id,
        };
      }
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
      return { tabs: [...state.tabs, tab], activeTabId: id };
    }),

  openTerminal: (id, cwd, title) =>
    set((state) => {
      const existing = state.tabs.find((t) => t.id === id);
      if (existing) {
        return {
          tabs: state.tabs.map((t) =>
            t.id === id ? { ...t, hidden: false } : t,
          ),
          activeTabId: id,
        };
      }
      const tab: IntegratedTerminalTab = {
        id,
        kind: 'integrated-terminal',
        location: 'editor',
        title,
        hidden: false,
        order: nextOrder(state.tabs),
        cwd,
      };
      return { tabs: [...state.tabs, tab], activeTabId: id };
    }),

  selectTab: (id) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return {};
      return { activeTabId: id };
    }),

  closeTab: (id) =>
    set((state) => {
      const remaining = state.tabs.filter((t) => t.id !== id);
      const patch: Partial<TabStore> = { tabs: remaining };
      if (state.activeTabId === id) {
        const visible = remaining.filter((t) => !t.hidden);
        patch.activeTabId = visible.length ? visible[0].id : null;
      }
      return patch;
    }),

  hideTab: (id) =>
    set((state) => {
      const tabs = state.tabs.map((t) => (t.id === id ? { ...t, hidden: true } : t));
      const patch: Partial<TabStore> = { tabs };
      if (state.activeTabId === id) {
        const visible = tabs.filter((t) => !t.hidden);
        patch.activeTabId = visible.length ? visible[0].id : null;
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
        patch.activeTabId = id;
      } else if (hidden && state.activeTabId === id) {
        const visible = tabs.filter((t) => !t.hidden);
        patch.activeTabId = visible.length ? visible[0].id : null;
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
      const remaining = state.tabs.filter(
        (t) => !(t.kind === 'session' && (t as SessionTab).key === key),
      );
      if (remaining.length === state.tabs.length) return {};
      const patch: Partial<TabStore> = { tabs: remaining };
      if (state.activeTabId && !remaining.some((t) => t.id === state.activeTabId)) {
        const visible = remaining.filter((t) => !t.hidden);
        patch.activeTabId = visible.length ? visible[0].id : null;
      }
      return patch;
    }),

  removeTerminalTab: (id) =>
    set((state) => {
      const remaining = state.tabs.filter(
        (t) => !(t.kind === 'integrated-terminal' && t.id === id),
      );
      if (remaining.length === state.tabs.length) return {};
      const patch: Partial<TabStore> = { tabs: remaining };
      if (state.activeTabId === id) {
        const visible = remaining.filter((t) => !t.hidden);
        patch.activeTabId = visible.length ? visible[0].id : null;
      }
      return patch;
    }),

  closeCenterTab: (id) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return {};
      // session / integrated-terminal 终端：keep-alive，仅隐藏不卸载。
      if (tab.kind === 'session' || tab.kind === 'integrated-terminal') {
        if (state.tabs.some((t) => t.id === id && t.hidden)) return {};
        const tabs = state.tabs.map((t) => (t.id === id ? { ...t, hidden: true } : t));
        const patch: Partial<TabStore> = { tabs };
        // 如果隐藏的是当前激活 tab，把激活指针移到下一个可见 tab（与 hideTab/setHidden 一致）。
        if (state.activeTabId === id) {
          const visible = tabs.filter((t) => !t.hidden);
          patch.activeTabId = visible.length ? visible[0].id : null;
        }
        return patch;
      }
      // preview / diff：真移除。
      const remaining = state.tabs.filter((t) => t.id !== id);
      const patch: Partial<TabStore> = { tabs: remaining };
      if (state.activeTabId === id) {
        const visible = remaining.filter((t) => !t.hidden);
        patch.activeTabId = visible.length ? visible[0].id : null;
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
