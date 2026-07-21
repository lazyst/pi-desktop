// 中间区容器（按工作目录分组）
//
// 根据 store.activeCwd 只显示当前工作目录的 tab 条和内容。
// 每个目录拥有独立的 tab 条和激活状态，切换目录时保留各自的 tab。
//
// 渲染结构：
//   .center-pane （纵向 flex）
//     ├─ .center-pane-cwd-label（当前目录标签）
//     ├─ TabBar（当前目录的 tab 条）
//     └─ .center-pane-body（flex:1，当前目录的所有 tab 内容，非 active 的 display:none）
import { useRef, useMemo, useEffect, useCallback } from 'react';
import { TabBar } from './TabBar';
import type { TabKind } from './TabBar';
import { SessionPane } from './SessionPane';
import { IntegratedPane } from './IntegratedPane';
import { PreviewTab } from './PreviewTab';
import { DiffTab } from './DiffTab';
import { useTabStore, getTabCwd, cwdVisibleTabs } from '../store/tabStore';
import type { Tab } from '../store/tabStore';
import { restorePaneScrollState } from './paneManager';

interface Props {
  onOpenFile?: (relPath: string, fileName: string, root: string) => void;
  /** 集成终端 × 关闭：先在主进程杀 PTY，再移除 tab。传 undefined 时走 keep-alive 隐藏。 */
  onDestroyTerminal?: (id: string) => void;
}

export function CenterPane({ onOpenFile, onDestroyTerminal }: Props) {
  const tabs = useTabStore((s) => s.tabs) as Tab[];
  const activeTabId = useTabStore((s) => s.activeTabId);
  const activeCwd = useTabStore((s) => s.activeCwd);
  const closeCenterTab = useTabStore((s) => s.closeCenterTab);
  const reorderTabs = useTabStore((s) => s.reorderTabs);
  const selectTab = useTabStore((s) => s.selectTab);
  const cwdOrder = useTabStore((s) => s.cwdOrder);
  const setActiveCwd = useTabStore((s) => s.setActiveCwd);

  // 当前目录的可见 tab（给 TabBar 用）
  const orderedVisibleTabs = useMemo(
    () => (activeCwd ? cwdVisibleTabs(tabs, activeCwd) : []),
    [tabs, activeCwd],
  );
  // 当前目录的全部 tab（含 hidden，keep-alive 需要全部渲染在 DOM 中）
  const cwdAllTabs = useMemo(
    () => (activeCwd ? tabs.filter((t) => getTabCwd(t) === activeCwd) : []),
    [tabs, activeCwd],
  );

  /** activeCwd 变化 → 恢复新目录中所有终端 pane 的滚动位置（DOM 已更新，pane 重新 visible）。
   *  保存由 store.setActiveCwd 在 DOM 更新前完成。 */
  useEffect(() => {
    if (!activeCwd) return;
    const state = useTabStore.getState();
    for (const t of state.tabs) {
      if (getTabCwd(t) !== activeCwd) continue;
      if (t.kind !== 'session' && t.kind !== 'integrated-terminal') continue;
      restorePaneScrollState(t.id);
    }
  }, [activeCwd]);

  /** 包装 setActiveCwd：restore 由 useEffect 处理。 */
  const handleSetActiveCwd = useCallback((cwd: string) => {
    setActiveCwd(cwd);
  }, [setActiveCwd]);

  /** 包装 selectTab：save 由 store.selectTab 内部完成，restore 由 useEffect 处理。 */
  const handleSelectTab = useCallback((id: string) => {
    selectTab(id);
  }, [selectTab]);


  // 各 tab 关闭请求拦截器（如 PreviewTab 的 dirty 确认）。
  const closeGuards = useRef<Map<string, () => void>>(new Map());

  const requestCloseTab = (id: string) => {
    const guard = closeGuards.current.get(id);
    if (guard) guard();
    else if (onDestroyTerminal) {
      const tabs = useTabStore.getState().tabs;
      const tab = tabs.find((t) => t.id === id);
      if (tab?.kind === 'integrated-terminal') {
        onDestroyTerminal(id);   // 杀 PTY + 移除 tab
      } else {
        closeCenterTab(id);     // session/preview/diff 走原逻辑
      }
    } else {
      closeCenterTab(id);
    }
  };

  const registerCloseGuard = (id: string, guard: (() => void) | null) => {
    if (guard) closeGuards.current.set(id, guard);
    else closeGuards.current.delete(id);
  };

  // 目录名（取路径最后一段）
  const cwdLabel = useMemo(() => {
    if (!activeCwd) return null;
    const idx = Math.max(activeCwd.lastIndexOf('/'), activeCwd.lastIndexOf('\\'));
    return idx >= 0 ? activeCwd.slice(idx + 1) : activeCwd;
  }, [activeCwd]);

  // 有 tab 的其他目录列表（供目录标签下拉切换）
  const otherCwds = useMemo(
    () => cwdOrder.filter((c) => c !== activeCwd),
    [cwdOrder, activeCwd],
  );

  const hasContent = orderedVisibleTabs.length > 0;

  return (
    <div className="center-pane">
      {/* 目录标签 */}
      {activeCwd && (
        <div className="center-pane-cwd-bar">
          <span className="cwd-label" title={activeCwd}>
            📁 {cwdLabel}
          </span>
          {otherCwds.length > 0 && (
            <span className="cwd-switch">
              {otherCwds.map((c) => {
                const name = c.split(/[\\/]/).pop() || c;
                return (
                  <button
                    key={c}
                    className="cwd-switch-btn"
                    title={c}
                    onClick={() => handleSetActiveCwd(c)}
                  >
                    {name}
                  </button>
                );
              })}
            </span>
          )}
        </div>
      )}
      <TabBar
        tabs={orderedVisibleTabs.map((t) => ({
          id: t.id,
          title: t.title,
          kind: t.kind as TabKind,
        }))}
        activeId={activeTabId}
        onSelect={handleSelectTab}
        onClose={requestCloseTab}
        onReorder={(orderedIds) => reorderTabs(orderedIds)}
        showNew={false}
      />
      <div className="center-pane-body">
        {/* 跨目录 keep-alive：所有 tab 内容永久挂载在 DOM 中。
            非 active 的用 opacity:0 + position:absolute 隐藏（canvas 保持有效尺寸，
            xterm 的滚动位置自然保留）；active 的用 opacity:1 显示。
            对齐 Orca 做法：隐藏时不卸载 DOM，滚动位置在切回目录时用 marker 恢复。 */}
        {tabs.map((t) => {
          const isActive = t.id === activeTabId;
          const cls = isActive ? 'tab-content active' : 'tab-content';
          if (t.kind === 'session') {
            return <div key={t.id} className={cls}><SessionPane sessionKey={t.key} active={isActive} /></div>;
          }
          if (t.kind === 'integrated-terminal') {
            return <div key={t.id} className={cls}><IntegratedPane terminalId={t.id} active={isActive} /></div>;
          }
          if (t.kind === 'preview') {
            return (
              <div key={t.id} className={cls}>
                <PreviewTab
                  tabId={t.id}
                  root={t.root}
                  path={t.path}
                  active={isActive}
                  onOpenFile={onOpenFile}
                  onClose={() => closeCenterTab(t.id)}
                  onRegisterCloseGuard={registerCloseGuard}
                />
              </div>
            );
          }
          return <div key={t.id} className={cls}><DiffTab cwd={t.cwd} commitHash={t.commitHash} active={isActive} onBack={() => closeCenterTab(t.id)} /></div>;
        })}
        {/* 无可见 tab 且无 keep-alive 内容时显示空状态 */}
        {cwdAllTabs.length === 0 && (
          <div className="empty-state">
            {activeCwd
              ? '当前目录没有打开的 tab，从左侧选择一个会话。'
              : '请先在左侧添加工作目录，然后选择会话。'}
          </div>
        )}
      </div>
    </div>
  );
}
