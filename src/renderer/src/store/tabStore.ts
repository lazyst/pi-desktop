// 统一 Tab store 骨架（ADR-0001 决策②：zustand 作全局 tab store）。
//
// 本文件是阶段1 的第一块拼图：仅导出类型 + 空 store 骨架，暂不接入任何组件
// （见 issue 01）。store 的初始形状从原 `App.tsx` 的以下状态推导而来：
//   • tabs            ← App 的 `tabs`（AnyTab[]，单一 tab 列表）
//   • activeTabId     ← App 的 `activeTabId`（中间区激活 tab）
//   • closedTabIds    ← App 的 `closedTabIds`（session 关闭隐藏集，不卸载）
//
// 对齐 CONTEXT.md 术语：
//   • TabKind 新增 `integrated-terminal`（原集成终端抽屉的 tab 类型）
//   • TabLocation 区分落点区域（editor / panel / floating）
//   • `hidden` 取代独立的 closedTabIds 集合，表达「关闭=隐藏不卸载」keep-alive
//   • `order` 驱动同 location 内的拖拽重排（TabReorder，阶段4 才用）
//
// 活跃指针拆为 `activeEditorTabId` / `activePanelTabId` 两个（ADR-0001 备选 B2 思路）：
// 中间区（editor）与底部终端区（panel）各自维护激活 tab，避免跨区域互相抢占。
//
// 当前所有 action 均为 no-op / 最小实现，组件接入（阶段1 后续）前不会用到。

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

export interface TabStore {
  // —— 状态 ——
  tabs: Tab[];
  activeEditorTabId: string | null; // 中间区（editor）激活 tab
  activePanelTabId: string | null; // 底部终端区（panel）激活 tab

  // —— action（占位，阶段1 后续接入组件时实现）——
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

export const useTabStore = create<TabStore>((set) => ({
  tabs: [],
  activeEditorTabId: null,
  activePanelTabId: null,

  // 以下 action 暂为 no-op / 最小实现，组件接入前不会被调用。
  openSession: () => {},
  openPreview: () => {},
  openDiff: () => {},
  openTerminal: () => {},
  selectTab: () => {},
  closeTab: () => {},
  hideTab: () => {},
  reorderTabs: () => {},
  setHidden: () => {},
}));
