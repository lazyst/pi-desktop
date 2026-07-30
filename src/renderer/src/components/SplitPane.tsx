// 递归分屏渲染组件
//
// SplitPane 根据分屏树（SplitTree）的节点类型递归渲染：
// - SplitLeaf → TabBar + tab 内容区
// - SplitNode → 子 SplitPane + SplitDivider（递归）
//
// 所有 cwd 的分屏树同时存在于 DOM 中（keep-alive），
// 非活跃 cwd 用 opacity:0 + pointer-events:none + position:absolute 隐藏。

import { useRef, useMemo, useEffect, useCallback, useState } from 'react';
import { TabBar } from './TabBar';
import { SplitDivider } from './SplitDivider';
import { useSplitStore, getTabCwd, cwdVisibleTabs } from '../store/splitStore';
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

/** 比较两个数组是否浅相等。 */
function shallowEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 获取 leaf 中所有 visible tab 的 id 列表（用于 memo）。 */
function leafVisibleTabIds(leaf: SplitLeaf): string[] {
  return leaf.tabs.filter((t) => !t.hidden).sort((a, b) => a.order - b.order).map((t) => t.id);
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

  return (
    <div className="split-pane-leaf" onClick={handleLeafClick}>
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
      {node.children.map((child, idx) => (
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
        </div>
      ))}
      {/* 分割线：在每对相邻子节点之间 */}
      {node.children.slice(0, -1).map((_, idx) => (
        <SplitDivider
          key={`divider-${idx}`}
          direction={node.direction}
          onMouseDown={(e) => handleMouseDown(idx, e)}
        />
      ))}
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

  if (tree.type === 'leaf') {
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
        <SplitPaneLeaf leaf={tree} {...props} />
      </div>
    );
  }

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
      <SplitPaneNode node={tree} {...props} />
    </div>
  );
}