// 中间区容器（重构阶段 3E）：三栏布局的中间栏，承载统一 TabBar + 当前 active tab 内容
// + 底部集成终端抽屉（TerminalDrawer 仅跨中间栏，不触碰左/右栏）。
//
// 本组件不再持有业务状态——所有 tab / 激活指针 / 抽屉状态均由 useTabStore 持有
// （App 仅把主进程 IPC 事件写回 store，见 issue 03）。CenterPane 直接订阅 store 取数，
// 渲染层只做「根据 tabs / active 渲染对应内容」与「把交互写回 store action」。
//
// 渲染结构：
//   .center-pane （纵向 flex）
//     ├─ TabBar（统一 tab 条：session / preview / diff 三种 kind）
//     ├─ .center-pane-body（flex:1，相对定位；所有 tab 内容都渲染，非 active 的 display:none）
//     └─ TerminalDrawer（底部抽屉，仅当 drawerOpen 时挂载，且只在此容器内）
//
// keep-alive：所有 tab 内容（SessionPane / PreviewTab / DiffTab）始终挂载，非 active 的
// 加 .tab-content（非 active 即无 .active）class，由 CSS 控制 display:none——切换 tab 不重建、
// 不闪首帧（对齐 SessionPane / IntegratedPane 的 keep-alive 模式）。
import { TabBar } from './TabBar';
import type { TabKind } from './TabBar';
import { SessionPane } from './SessionPane';
import { PreviewTab } from './PreviewTab';
import { DiffTab } from './DiffTab';
import { TerminalDrawer } from './TerminalDrawer';
import { useRef } from 'react';
import { useTabStore } from '../store/tabStore';
import type { Tab } from '../store/tabStore';

interface Props {
  // 集成终端新建 / 抽屉高度拖拽 / 关闭终端 tab：仍由 App 持有，因为涉及主进程
  // profile / cwd 业务、config 持久化与 pty 销毁（destroyTerminal），无法通过 store 完成
  // （store 不依赖 pi）；通过这几个回调传入，TerminalDrawer 内部的状态（terminals /
  // activeTermId）则直接从 store 订阅。其余中间区与终端抽屉状态均来自 store。
  onNewTerminal: () => void;
  onResizeDrawer: (h: number) => void;
  onCloseTermTab: (id: string) => void;
  onOpenFile?: (relPath: string, fileName: string, root: string) => void;
}

export function CenterPane({ onNewTerminal, onResizeDrawer, onCloseTermTab, onOpenFile }: Props) {
  // 直接订阅 store：tabs / 激活指针 / 抽屉状态。store 用 `hidden` 字段承载
  // 「关闭隐藏（keep-alive）」语义，替代早期 App 的 closedTabIds 集合。
  const tabs = useTabStore((s) => s.tabs) as Tab[];
  const activeTabId = useTabStore((s) => s.activeEditorTabId);
  const drawerOpen = useTabStore((s) => s.drawerOpen);
  const drawerHeight = useTabStore((s) => s.drawerHeight);
  const closeCenterTab = useTabStore((s) => s.closeCenterTab);
  // 拖拽重排（ADR-0001 TabReorder）：仅改同 location 的 order，不碰渲染实例（keep-alive 不受影响）。
  const reorderTabs = useTabStore((s) => s.reorderTabs);
  // 集成终端 tab 选中直接用 store action；关闭则需 App 协调主进程销毁（见 onCloseTermTab）。
  const selectTermTab = useTabStore((s) => s.selectTab);

  // 可见 tab = 排除被「关闭隐藏」的（hidden=true）。TabBar 只渲染可见 tab；内容区仍渲染
  // 全部 tab（keep-alive）。tabs 已是 store 状态，按需过滤即可，无需 App 透传 closedTabIds。
  // TabBar 的视觉顺序需跟随 store.order（拖拽重排只改 order），故按 order 升序提供给 TabBar；
  // 内容区渲染循环仍用未排序的 tabs（keyed by id，顺序无关 keep-alive）。
  const visibleTabs = tabs.filter((t) => !t.hidden);
  const orderedVisibleTabs = visibleTabs
    .filter((t) => t.location === 'editor')
    .sort((a, b) => a.order - b.order);

  // 各 tab 的「关闭请求拦截器」（如 PreviewTab 的 dirty 确认）。TabBar 的 × 不直接关，
  // 而是先查这里注册的 guard：有则走拦截逻辑（dirty 弹确认），无则直接关。
  // 仅 preview tab 注册（session/diff tab 无 dirty 概念，直接关）。
  // 该 Map 是 CenterPane 内部的协调状态（UI 拦截回调），不跨组件共享，故保留为局部 ref，
  // 不放进全局 store（store 仅作状态容器，见 tabStore.ts 顶部注释）。
  const closeGuards = useRef<Map<string, () => void>>(new Map());

  // TabBar × 的统一入口：先问对应 tab 的 guard，无 guard 才走 store 的 closeCenterTab。
  const requestCloseTab = (id: string) => {
    const guard = closeGuards.current.get(id);
    if (guard) guard();
    else closeCenterTab(id);
  };

  const registerCloseGuard = (id: string, guard: (() => void) | null) => {
    if (guard) closeGuards.current.set(id, guard);
    else closeGuards.current.delete(id);
  };

  return (
    <div className="center-pane">
      <TabBar
        tabs={orderedVisibleTabs.map((t) => ({ id: t.id, title: t.title, kind: t.kind as TabKind }))}
        activeId={activeTabId}
        onSelect={selectTermTab}
        onClose={requestCloseTab}
        onReorder={(orderedIds) => reorderTabs('editor', orderedIds)}
        showNew={false}
      />
      <div className="center-pane-body">
        {tabs.map((t) => {
          // 中间区只承载 editor 落点的 tab（session / preview / diff）；
          // 集成终端（location==='panel'）由 TerminalDrawer 渲染，不在此处。
          if (t.location !== 'editor') return null;
          const isActive = t.id === activeTabId;
          const cls = isActive ? 'tab-content active' : 'tab-content';
          if (t.kind === 'session') {
            return <div key={t.id} className={cls}><SessionPane sessionKey={t.key} active={isActive} /></div>;
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
        {visibleTabs.length === 0 && <div className="empty-state">从左侧选择一个会话，或新建会话。</div>}
      </div>
      {drawerOpen && (
        <TerminalDrawer
          open={drawerOpen}
          height={drawerHeight}
          onSelectTab={selectTermTab}
          onCloseTab={onCloseTermTab}
          onNewTerminal={onNewTerminal}
          onResizeHeight={onResizeDrawer}
        />
      )}
    </div>
  );
}
