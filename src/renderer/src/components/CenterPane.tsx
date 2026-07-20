// 中间区容器（重构阶段 3E）：三栏布局的中间栏，承载统一 TabBar + 当前 active tab 内容
// + 底部集成终端抽屉（TerminalDrawer 仅跨中间栏，不触碰左/右栏）。
//
// 本组件本身不持有业务状态——所有状态由 App 传入（App 保持单一状态源），渲染层只做
// 「根据 tabs / active 渲染对应内容」与「把交互回调透传给 App」。
//
// 渲染结构：
//   .center-pane （纵向 flex）
//     ├─ TabBar（统一 tab 条：session / preview / diff 三种 kind）
//     ├─ .center-pane-body（flex:1，相对定位；所有 tab 内容都渲染，非 active 的 display:none）
//     └─ TerminalDrawer（底部抽屉，仅当 drawerOpen 时挂载，且只在此容器内）
//
// keep-alive：所有 tab 内容（TerminalPane / PreviewTab / DiffTab）始终挂载，非 active 的
// 加 .tab-content（非 active 即无 .active）class，由 CSS 控制 display:none——切换 tab 不重建、
// 不闪首帧（对齐 TerminalPane / IntegratedTerminalPane 的 keep-alive 模式）。
import { TabBar } from './TabBar';
import { TerminalPane } from './TerminalPane';
import { PreviewTab } from './PreviewTab';
import { DiffTab } from './DiffTab';
import { TerminalDrawer } from './TerminalDrawer';
import { useRef } from 'react';
import type { AnyTab, IntegratedTerminalInfo } from '../types';

interface Props {
  tabs: AnyTab[];
  activeTabId: string | null;
  // 被「关闭隐藏」的 tab id 集合（仅 session 终端使用）：这些 tab 仍保留实例（keep-alive），
  // 只是不显示 tab 条、不激活；从侧边栏重新点开即恢复。TabBar 不渲染它们，但内容区仍渲染
  // 其 TerminalPane（display:none 隐藏），以复用实例、避免重挂载。
  closedTabIds: string[];
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;       // 中间区 tab（session/preview/diff）关闭
  drawerOpen: boolean;
  drawerHeight: number;
  terminals: IntegratedTerminalInfo[];
  activeTermId: string | null;
  onSelectTermTab: (id: string) => void;
  onCloseTermTab: (id: string) => void;   // 集成终端 tab 关闭（销毁 pty）
  onNewTerminal: () => void;
  onResizeDrawer: (h: number) => void;
  onOpenFile?: (relPath: string, fileName: string, root: string) => void;
}

export function CenterPane({
  tabs,
  activeTabId,
  closedTabIds,
  onSelectTab,
  onCloseTab,
  drawerOpen,
  drawerHeight,
  terminals,
  activeTermId,
  onSelectTermTab,
  onCloseTermTab,
  onNewTerminal,
  onResizeDrawer,
  onOpenFile,
}: Props) {
  // 可见 tab = 排除被「关闭隐藏」的。TabBar 只渲染可见 tab；内容区仍渲染全部 tab（keep-alive）。
  const visibleTabs = tabs.filter((t) => !closedTabIds.includes(t.id));
  // 各 tab 的「关闭请求拦截器」（如 PreviewTab 的 dirty 确认）。TabBar 的 × 不直接关，
  // 而是先查这里注册的 guard：有则走拦截逻辑（dirty 弹确认），无则直接关。
  // 仅 preview tab 注册（session/diff tab 无 dirty 概念，直接关）。
  const closeGuards = useRef<Map<string, () => void>>(new Map());

  // TabBar × 的统一入口：先问对应 tab 的 guard，无 guard 才直接关。
  const requestCloseTab = (id: string) => {
    const guard = closeGuards.current.get(id);
    if (guard) guard();
    else onCloseTab(id);
  };

  const registerCloseGuard = (id: string, guard: (() => void) | null) => {
    if (guard) closeGuards.current.set(id, guard);
    else closeGuards.current.delete(id);
  };

  return (
    <div className="center-pane">
      <TabBar
        tabs={visibleTabs.map((t) => ({ id: t.id, title: t.title, kind: t.kind }))}
        activeId={activeTabId}
        onSelect={onSelectTab}
        onClose={requestCloseTab}
        showNew={false}
      />
      <div className="center-pane-body">
        {tabs.map((t) => {
          const isActive = t.id === activeTabId;
          const cls = isActive ? 'tab-content active' : 'tab-content';
          if (t.kind === 'session') {
            return <div key={t.id} className={cls}><TerminalPane sessionKey={t.key} active={isActive} /></div>;
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
                  onClose={() => onCloseTab(t.id)}
                  onRegisterCloseGuard={registerCloseGuard}
                />
              </div>
            );
          }
          return <div key={t.id} className={cls}><DiffTab cwd={t.cwd} commitHash={t.commitHash} active={isActive} onBack={() => onCloseTab(t.id)} /></div>;
        })}
        {visibleTabs.length === 0 && <div className="empty-state">从左侧选择一个会话，或新建会话。</div>}
      </div>
      {drawerOpen && (
        <TerminalDrawer
          open={drawerOpen}
          height={drawerHeight}
          tabs={terminals.map((t) => ({ id: t.id, title: t.title }))}
          activeId={activeTermId}
          onSelectTab={onSelectTermTab}
          onCloseTab={onCloseTermTab}
          onNewTerminal={onNewTerminal}
          onResizeHeight={onResizeDrawer}
        />
      )}
    </div>
  );
}
