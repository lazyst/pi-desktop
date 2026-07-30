// 递归分屏渲染组件
//
// SplitPane 根据分屏树（SplitTree）的节点类型递归渲染：
// - SplitLeaf → TabBar + tab 内容区
// - SplitNode → 子 SplitPane + SplitDivider（递归）
//
// 所有 cwd 的分屏树同时存在于 DOM 中（keep-alive），
// 非活跃 cwd 用 opacity:0 + pointer-events:none + position:absolute 隐藏。
//
// 跨 leaf Tab 拖拽（ADR-0002）：
// - SplitPaneDragProvider 包装每个 cwd 的分屏树，持有 DndContext
// - 每个 leaf 的 TabBar 共享同一 DndContext，各自持有独立的 SortableContext
// - 通过 DragContext 将 leaf items 动态传递给 TabBar

import { useRef, useMemo, useEffect, useCallback, useState, createContext, useContext } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { TabBar } from './TabBar';
import { SplitDivider } from './SplitDivider';
import { useSplitStore, findTabById, findLeaf, canMoveTabToLeaf } from '../store/splitStore';
import type { SplitTree, SplitLeaf, SplitNode, Tab, SessionContentTab } from '../store/splitStore';
import type { TabKind } from './TabBar';
import { SessionPane } from './SessionPane';
import { IntegratedPane } from './IntegratedPane';
import { PreviewTab } from './PreviewTab';
import { DiffTab } from './DiffTab';
import { SessionContentView } from './SessionContentView';
import { restorePaneScrollState } from './paneManager';

interface Props {
  tree: SplitTree;
  cwd: string;
  isActive: boolean;
  onOpenFile?: (relPath: string, fileName: string, root: string) => void;
  onDestroyTerminal?: (id: string) => void;
  onDestroySession?: (id: string) => void;
  onOpen?: (req: { key?: string; cwd?: string; name?: string }) => void;
  onNewTerminal?: () => void;
  onNewTerminalWithProfile?: (profileId: string) => void;
  terminalProfiles?: Array<{ id: string; label: string }>;
  closeGuards: React.MutableRefObject<Map<string, () => void>>;
  requestCloseTab: (id: string) => void;
  registerCloseGuard: (id: string, guard: (() => void) | null) => void;
  addedDirs?: string[];
  // 分屏回调
  onSplitPane?: (leafId: string, direction: 'horizontal' | 'vertical') => void;
}

// ── DragContext（跨 leaf 拖拽状态传递） ──

interface DragContextValue {
  /** 每个 leaf 的 SortableContext items（动态管理，含拖拽中的临时变更）。 */
  leafItems: Record<string, string[]>;
  /** 设置为 true 时表示某 leaf 正在被拖拽悬停。 */
  hoveredLeafId: string | null;
  canDrop: boolean;
}

const DragContext = createContext<DragContextValue>({
  leafItems: {},
  hoveredLeafId: null,
  canDrop: true,
});

export function useDragContext() {
  return useContext(DragContext);
}

// ── SplitPaneDragProvider ──

/**
 * 跨 leaf Tab 拖拽的 DndContext 提供者。
 * 包装单个 cwd 的分屏树，所有 leaf 的 TabBar 共享此 DndContext。
 * 每个 cwd 使用独立的 SplitPaneDragProvider 实例。
 */
function SplitPaneDragProvider({
  children,
  cwd,
  isActive,
}: {
  children: React.ReactNode;
  cwd: string;
  isActive: boolean;
}) {
  const moveTabAcrossLeafs = useSplitStore((s) => s.moveTabAcrossLeafs);
  const reorderTabsInLeaf = useSplitStore((s) => s.reorderTabsInLeaf);
  const cwdTrees = useSplitStore((s) => s.cwdTrees);

  // 拖拽状态
  const [leafItems, setLeafItems] = useState<Record<string, string[]>>({});
  const [hoveredLeafId, setHoveredLeafId] = useState<string | null>(null);
  const [canDrop, setCanDrop] = useState(true);
  /** ref 存储 drag item，回调总能读到最新值（避免 useCallback 闭包陈旧）。 */
  const activeDragItemRef = useRef<{ tabId: string; sourceLeafId: string } | null>(null);
  /** state 仅用于驱动 DragOverlay 渲染。 */
  const [activeDragTab, setActiveDragTab] = useState<Tab | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // 非活跃 cwd 不响应拖拽
  if (!isActive) {
    return <>{children}</>;
  }

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event;
    const tabId = String(active.id);

    // 在所有 cwd 的 leaf 中查找 tab
    const found = findTabById(cwdTrees, tabId);
    if (!found) return;

    const sourceLeafId = found.leaf.id;
    activeDragItemRef.current = { tabId, sourceLeafId };
    setActiveDragTab(found.tab);

    // 注意：不移除 items！@dnd-kit 的 useSortable 通过 isDragging
    // 自动处理占位符（透明度 + transform），留给原生多容器管理。
  }, [cwdTrees]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over || !active) return;

    const activeId = String(active.id);
    const overId = String(over.id);

    // 忽略 SplitDivider 区域
    if (overId.startsWith('split-divider-')) return;

    // 确定目标 leafId
    // over.id 可能是 tab id 或 leaf 级 droppable id
    let targetLeafId: string | null = null;
    if (overId.startsWith('leaf-')) {
      targetLeafId = overId.slice(5); // 'leaf-{leafId}'
    } else {
      // 是 tab id → 查找所属 leaf
      const found = findTabById(cwdTrees, overId);
      if (found) targetLeafId = found.leaf.id;
    }

    if (!targetLeafId) return;

    // 更新 hovered leaf 高亮
    setHoveredLeafId(targetLeafId);

    // 查找 active tab 信息
    const activeFound = findTabById(cwdTrees, activeId);
    if (!activeFound) return;

    const targetFound = findLeaf(cwdTrees, targetLeafId);
    if (!targetFound) return;

    // 检查是否可以移动到目标 leaf
    // 同 leaf 拖拽（重排）始终允许，不加去重限制
    // 跨 leaf 时才检查去重冲突
    // 使用 ref 读取，避免 useCallback 闭包陈旧
    const isSameLeaf = activeDragItemRef.current?.sourceLeafId === targetLeafId;
    const canDropResult = isSameLeaf ? true : canMoveTabToLeaf(
      activeFound.tab,
      targetFound.leaf,
      targetFound.cwd,
      cwdTrees,
    );
    setCanDrop(canDropResult);

    // 动态更新 SortableContext items
    // 同 leaf 拖拽不动 items（@dnd-kit 原生处理占位 + 位移）
    // 跨 leaf 时才需从 source 移除、加入 target
    if (!isSameLeaf) {
      setLeafItems((prev) => {
        const next = { ...prev };

        // 如果目标 leaf 中已存在该 tab id，不再重复添加
        if (next[targetLeafId]?.includes(activeId)) return prev;

        if (canDropResult) {
          // 从所有 leaf 的 items 中移除（主要从 source leaf 移除）
          for (const key of Object.keys(next)) {
            next[key] = next[key].filter((id) => id !== activeId);
          }
          // 加入目标 leaf
          // 确定插入位置：如果 overId 是 tab id，放在该 tab 前面；否则追加到末尾
          if (overId.startsWith('leaf-')) {
            // 拖到空白区域 → 追加到末尾
            next[targetLeafId] = [...(next[targetLeafId] ?? []), activeId];
          } else {
            // 拖到某个 tab 上 → 插入到该 tab 前面
            const items = next[targetLeafId] ?? [];
            const overIdx = items.indexOf(overId);
            if (overIdx >= 0) {
              items.splice(overIdx, 0, activeId);
              next[targetLeafId] = items;
            } else {
              next[targetLeafId] = [...items, activeId];
            }
          }
        } else {
          // canDrop 为 false → 确保目标 leaf 的 items 中没有该 tab id
          if (next[targetLeafId]) {
            next[targetLeafId] = next[targetLeafId].filter((id) => id !== activeId);
          }
        }

        return next;
      });
    }
  }, [cwdTrees]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    const activeId = String(active.id);

    // 清理临时状态
    setHoveredLeafId(null);
    setCanDrop(true);
    const dragItem = activeDragItemRef.current;
    activeDragItemRef.current = null;
    setActiveDragTab(null);

    // 恢复所有 leaf items 为空（TabBar 将使用默认的 tabs 顺序）
    setLeafItems({});

    // 拖拽被取消
    if (!over) return;

    const overId = String(over.id);

    // 忽略 SplitDivider
    if (overId.startsWith('split-divider-')) return;

    if (!dragItem) return;
    const { sourceLeafId } = dragItem;

    // 确定目标 leafId
    let targetLeafId: string | null = null;
    if (overId.startsWith('leaf-')) {
      targetLeafId = overId.slice(5);
    } else {
      const found = findTabById(cwdTrees, overId);
      if (found) targetLeafId = found.leaf.id;
    }

    if (!targetLeafId) return;

    // 同 leaf → reorder
    if (sourceLeafId === targetLeafId) {
      // 获取当前 leaf 的可见 tab 顺序
      const foundLeaf = findLeaf(cwdTrees, sourceLeafId);
      if (!foundLeaf) return;
      const visibleTabs = foundLeaf.leaf.tabs
        .filter((t) => !t.hidden)
        .sort((a, b) => a.order - b.order);
      const visibleIds = visibleTabs.map((t) => t.id);

      // 如果 activeId 还在列表中（说明拖拽结束时被放回原 leaf）
      if (visibleIds.includes(activeId)) {
        // 计算新的顺序
        const oldIdx = visibleIds.indexOf(activeId);
        let newIdx: number;
        if (overId.startsWith('leaf-')) {
          newIdx = visibleIds.length - 1; // 追加到末尾
        } else {
          newIdx = visibleIds.indexOf(overId);
        }
        if (newIdx < 0) newIdx = visibleIds.length - 1;

        const reordered = [...visibleIds];
        reordered.splice(oldIdx, 1);
        reordered.splice(newIdx, 0, activeId);
        reorderTabsInLeaf(sourceLeafId, reordered);
      }
      return;
    }

    // 跨 leaf → 检查去重
    const activeFound = findTabById(cwdTrees, activeId);
    const targetFound = findLeaf(cwdTrees, targetLeafId);
    if (!activeFound || !targetFound) return;

    const canDropResult = canMoveTabToLeaf(
      activeFound.tab,
      targetFound.leaf,
      targetFound.cwd,
      cwdTrees,
    );
    if (!canDropResult) return; // 去重冲突，跳过

    // 计算 targetIndex
    let targetIndex: number;
    if (overId.startsWith('leaf-')) {
      targetIndex = targetFound.leaf.tabs.length; // 追加到末尾
    } else {
      // 找到 over tab 在完整 tabs[] 中的索引
      const overIdx = targetFound.leaf.tabs.findIndex((t) => t.id === overId);
      targetIndex = overIdx >= 0 ? overIdx : targetFound.leaf.tabs.length;
    }

    moveTabAcrossLeafs(activeId, sourceLeafId, targetLeafId, targetIndex);
  }, [cwdTrees, reorderTabsInLeaf, moveTabAcrossLeafs]);

  // 构建每个 leaf 的默认 items（按 visible tab 顺序）
  // 仅在 leafItems 为空时使用
  const defaultLeafItems = useMemo(() => {
    const items: Record<string, string[]> = {};
    const tree = cwdTrees[cwd];
    if (!tree) return items;
    const traverse = (node: SplitTree) => {
      if (node.type === 'leaf') {
        items[node.id] = node.tabs
          .filter((t) => !t.hidden)
          .sort((a, b) => a.order - b.order)
          .map((t) => t.id);
      } else {
        for (const child of node.children) traverse(child);
      }
    };
    traverse(tree);
    return items;
  }, [cwdTrees, cwd]);

  // 合并默认 items 和动态 items：动态 items 优先
  const mergedLeafItems = useMemo(() => {
    if (Object.keys(leafItems).length === 0) return defaultLeafItems;
    // 合并：用动态 items 覆盖默认 items
    const merged = { ...defaultLeafItems };
    for (const [leafId, items] of Object.entries(leafItems)) {
      merged[leafId] = items;
    }
    return merged;
  }, [defaultLeafItems, leafItems]);

  const contextValue = useMemo<DragContextValue>(() => ({
    leafItems: mergedLeafItems,
    hoveredLeafId,
    canDrop,
  }), [mergedLeafItems, hoveredLeafId, canDrop]);

  // 被拖拽的 tab 信息（用于 DragOverlay），直接使用 activeDragTab state
  const activeTab = activeDragTab;

  return (
    <DragContext.Provider value={contextValue}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {activeTab && (
            <div className={`drag-overlay${!canDrop ? ' drag-overlay--invalid' : ''}`}>
              <span className="drag-overlay-icon">
                {activeTab.kind === 'session' && '💬'}
                {activeTab.kind === 'integrated-terminal' && '⬛'}
                {activeTab.kind === 'preview' && '📄'}
                {activeTab.kind === 'diff' && '📝'}
                {activeTab.kind === 'session-content' && '💬'}
              </span>
              <span className="drag-overlay-title">{activeTab.title}</span>
              {!canDrop && <span className="drag-overlay-invalid-icon">🚫</span>}
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </DragContext.Provider>
  );
}

// ── Leaf 渲染 ──

function SplitPaneLeaf({
  leaf,
  cwd,
  isActive,
  onOpenFile,
  onDestroyTerminal,
  onDestroySession,
  onOpen,
  onNewTerminal,
  onNewTerminalWithProfile,
  terminalProfiles,
  closeGuards,
  requestCloseTab,
  registerCloseGuard,
  addedDirs,
  onSplitPane,
}: Props & { leaf: SplitLeaf }) {
  const selectTab = useSplitStore((s) => s.selectTab);
  const reorderTabsInLeaf = useSplitStore((s) => s.reorderTabsInLeaf);
  const setActiveLeaf = useSplitStore((s) => s.setActiveLeaf);
  const closeCenterTab = useSplitStore((s) => s.closeCenterTab);

  // 从 DragContext 获取 leaf 的动态 items
  const { leafItems, hoveredLeafId, canDrop } = useDragContext();
  const isDragOver = hoveredLeafId === leaf.id;

  // 该 leaf 的可见 tab（按 order 排序）
  const orderedVisibleTabs = useMemo(
    () => leaf.tabs.filter((t) => !t.hidden).sort((a, b) => a.order - b.order),
    [leaf.tabs],
  );

  // 恢复 pane 滚动位置（当 leaf 变为 active 时）
  useEffect(() => {
    if (!isActive) return;
    for (const t of leaf.tabs) {
      if (t.kind !== 'session' && t.kind !== 'integrated-terminal' && t.kind !== 'session-content') continue;
      restorePaneScrollState(t.id);
    }
  }, [isActive, leaf.tabs]);

  const handleSelectTab = useCallback((id: string) => {
    selectTab(id);
  }, [selectTab]);

  const handleReorder = useCallback((orderedIds: string[]) => {
    reorderTabsInLeaf(leaf.id, orderedIds);
  }, [reorderTabsInLeaf, leaf.id]);

  const handleLeafClick = useCallback(() => {
    setActiveLeaf(leaf.id);
  }, [setActiveLeaf, leaf.id]);

  const hasContent = orderedVisibleTabs.length > 0;

  const tabBarItems = orderedVisibleTabs.map((t) => ({
    id: t.id,
    title: t.title,
    kind: t.kind as TabKind,
  }));

  // 构建 leaf 的 SortableContext items
  const sortableItems = leafItems[leaf.id] ?? orderedVisibleTabs.map((t) => t.id);

  // 构建 leaf 高亮 class
  const leafClass = [
    'split-pane-leaf',
    isDragOver ? (canDrop ? 'split-pane-leaf--drag-over' : 'split-pane-leaf--drag-over--invalid') : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={leafClass} onClick={handleLeafClick}>
      <TabBar
        leafId={leaf.id}
        tabs={tabBarItems}
        activeId={leaf.activeTabId}
        onSelect={handleSelectTab}
        onClose={requestCloseTab}
        onReorder={handleReorder}
        showNew={false}
        onNewTerminal={onNewTerminal}
        onNewTerminalWithProfile={onNewTerminalWithProfile}
        terminalProfiles={terminalProfiles}
        onSplitPane={onSplitPane}
        sortableItems={sortableItems}
      />
      <div className="center-pane-body">
        {/* keep-alive：所有 tab 内容永久挂载，非 active 用 opacity:0 隐藏 */}
        {leaf.tabs.map((t) => {
          const tabActive = t.id === leaf.activeTabId;
          const cls = tabActive ? 'tab-content active' : 'tab-content';
          if (t.kind === 'session') {
            return <div key={t.id} className={cls}><SessionPane sessionKey={t.key} active={tabActive} /></div>;
          }
          if (t.kind === 'integrated-terminal') {
            return <div key={t.id} className={cls}><IntegratedPane terminalId={t.id} active={tabActive} /></div>;
          }
          if (t.kind === 'preview') {
            return (
              <div key={t.id} className={cls}>
                <PreviewTab
                  tabId={t.id}
                  root={t.root}
                  path={t.path}
                  active={tabActive}
                  onOpenFile={onOpenFile}
                  onClose={() => closeCenterTab(t.id)}
                  onRegisterCloseGuard={registerCloseGuard}
                />
              </div>
            );
          }
          if (t.kind === 'session-content') {
            const sc = t as SessionContentTab;
            return (
              <div key={t.id} className={cls}>
                <div className="session-content-tab-header">
                  <span className="session-content-tab-title">💬 {sc.sessionName}</span>
                </div>
                <SessionContentView sessionKey={sc.sessionKey} sessionName={sc.sessionName} />
              </div>
            );
          }
          return <div key={t.id} className={cls}><DiffTab cwd={t.cwd} commitHash={t.commitHash} active={tabActive} onBack={() => closeCenterTab(t.id)} /></div>;
        })}
        {/* 空状态 */}
        {leaf.tabs.length === 0 && (
          <div className="empty-state">
            {cwd ? (
              <div className="empty-state-buttons">
                <button
                  className="empty-state-new-session-btn"
                  onClick={() => onOpen?.({ cwd })}
                >
                  <span className="empty-state-plus">+</span>
                  <span>新建会话</span>
                </button>
                {onNewTerminal && (
                  <button
                    className="empty-state-new-session-btn"
                    onClick={onNewTerminal}
                  >
                    <span className="empty-state-plus">+</span>
                    <span>新建终端</span>
                  </button>
                )}
              </div>
            ) : (
              '请先在左侧添加工作目录，然后选择会话。'
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Split 节点渲染 ──

function SplitPaneNode({
  node,
  cwd,
  isActive,
  ...rest
}: Props & { node: SplitNode }) {
  const setRatios = useSplitStore((s) => s.setRatios);
  const splitRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<{ index: number; startPos: number; startRatios: number[] } | null>(null);

  const handleMouseDown = useCallback((index: number, e: React.MouseEvent) => {
    e.preventDefault();
    const rect = splitRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startPos = node.direction === 'horizontal' ? e.clientX : e.clientY;
    setDragging({ index, startPos, startRatios: [...node.ratios] });
  }, [node.direction, node.ratios]);

  // 拖拽逻辑
  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const rect = splitRef.current?.getBoundingClientRect();
      if (!rect) return;
      const totalSize = node.direction === 'horizontal' ? rect.width : rect.height;
      const delta = (node.direction === 'horizontal' ? e.clientX : e.clientY) - dragging.startPos;
      const deltaRatio = delta / totalSize;

      const newRatios = [...dragging.startRatios];
      const leftIdx = dragging.index;
      const rightIdx = dragging.index + 1;

      let newLeft = newRatios[leftIdx] + deltaRatio;
      let newRight = newRatios[rightIdx] - deltaRatio;

      // 最小比例约束 6%
      const minRatio = 0.06;
      if (newLeft < minRatio) {
        newRight -= (minRatio - newLeft);
        newLeft = minRatio;
      }
      if (newRight < minRatio) {
        newLeft -= (minRatio - newRight);
        newRight = minRatio;
      }

      if (newLeft <= 0 || newRight <= 0) return;

      newRatios[leftIdx] = newLeft;
      newRatios[rightIdx] = newRight;

      // 归一化
      const total = newRatios.reduce((a, b) => a + b, 0);
      const normalized = newRatios.map((r) => r / total);

      setRatios(node.id, normalized);
    };

    const handleMouseUp = () => {
      setDragging(null);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    // 锁定 body cursor
    document.body.style.cursor = node.direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging, node.direction, node.id, setRatios]);

  const fixedRatios = node.ratios;

  return (
    <div
      ref={splitRef}
      className={`split-pane-node split-pane-node--${node.direction}`}
    >
      {node.children.flatMap((child, idx) => {
        const elements: React.ReactNode[] = [
          <div
            key={child.id}
            className="split-pane-child"
            style={{ flex: `${fixedRatios[idx]}` }}
          >
            <SplitPaneChild
              child={child}
              cwd={cwd}
              isActive={isActive}
              {...rest}
            />
          </div>,
        ];
        // 在每对相邻子节点之间插入分割线
        if (idx < node.children.length - 1) {
          elements.push(
            <SplitDivider
              key={`divider-${idx}`}
              direction={node.direction}
              onMouseDown={(e) => handleMouseDown(idx, e)}
            />,
          );
        }
        return elements;
      })}
    </div>
  );
}

// ── 递归子节点渲染 ──

function SplitPaneChild({
  child,
  ...rest
}: Props & { child: SplitLeaf | SplitNode }) {
  if (child.type === 'leaf') {
    return <SplitPaneLeaf leaf={child} {...rest} />;
  }
  return <SplitPaneNode node={child} {...rest} />;
}

// ── 对外暴露的 SplitPane 组件 ──

export function SplitPane(props: Props) {
  const { tree, isActive, cwd } = props;

  const content = tree.type === 'leaf' ? (
    <SplitPaneLeaf leaf={tree} {...props} />
  ) : (
    <SplitPaneNode node={tree} {...props} />
  );

  return (
    <div
      className="split-pane"
      style={{
        opacity: isActive ? 1 : 0,
        pointerEvents: isActive ? 'auto' : 'none',
        position: 'absolute',
        inset: 0,
        zIndex: isActive ? 1 : 0,
      }}
    >
      <SplitPaneDragProvider cwd={cwd} isActive={isActive}>
        {content}
      </SplitPaneDragProvider>
    </div>
  );
}