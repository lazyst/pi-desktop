// 中间区容器（Phase 2 — 终端统一布局）
//
// 统一 TabBar + 所有 tab 内容（session / preview / diff / terminal），不再有底部抽屉。
// IntegratedPane（TerminalPane）与 SessionPane 同层级渲染，都走 keep-alive。
//
// 渲染结构：
//   .center-pane （纵向 flex）
//     ├─ TabBar（统一 tab 条：session / preview / diff / terminal 四种 kind）
//     └─ .center-pane-body（flex:1，所有 tab 内容都渲染，非 active 的 display:none）
import { TabBar } from './TabBar';
import type { TabKind } from './TabBar';
import { SessionPane } from './SessionPane';
import { IntegratedPane } from './IntegratedPane';
import { PreviewTab } from './PreviewTab';
import { DiffTab } from './DiffTab';
import { useRef } from 'react';
import { useTabStore } from '../store/tabStore';
import type { Tab } from '../store/tabStore';

interface Props {
  onNewTerminal: () => void;
  onOpenFile?: (relPath: string, fileName: string, root: string) => void;
  /** 集成终端 × 关闭：先在主进程杀 PTY，再移除 tab。传 undefined 时走 keep-alive 隐藏。 */
  onDestroyTerminal?: (id: string) => void;
}

export function CenterPane({ onNewTerminal, onOpenFile, onDestroyTerminal }: Props) {
  const tabs = useTabStore((s) => s.tabs) as Tab[];
  const activeTabId = useTabStore((s) => s.activeTabId);
  const closeCenterTab = useTabStore((s) => s.closeCenterTab);
  const reorderTabs = useTabStore((s) => s.reorderTabs);
  const selectTab = useTabStore((s) => s.selectTab);

  // 可见 tab = 排除被「关闭隐藏」的（hidden=true）。
  const visibleTabs = tabs.filter((t) => !t.hidden);
  const orderedVisibleTabs = [...visibleTabs].sort((a, b) => a.order - b.order);

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

  return (
    <div className="center-pane">
      <TabBar
        tabs={orderedVisibleTabs.map((t) => {
          const groupKey = t.kind === 'preview'
            ? (t as Extract<Tab, { kind: 'preview' }>).root
            : (t as Extract<Tab, { kind: 'session' | 'diff' | 'integrated-terminal' }>).cwd ?? '';
          return { id: t.id, title: t.title, kind: t.kind as TabKind, groupKey };
        })}
        activeId={activeTabId}
        onSelect={selectTab}
        onClose={requestCloseTab}
        onReorder={(orderedIds) => reorderTabs(orderedIds)}
        groupBy={(t) => t.groupKey}
        showNew={false}
      />
      <div className="center-pane-body">
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
        {visibleTabs.length === 0 && <div className="empty-state">从左侧选择一个会话，或新建终端。</div>}
      </div>
    </div>
  );
}
