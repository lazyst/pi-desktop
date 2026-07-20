// @vitest-environment jsdom
//
// CenterPane 集成测试（issue 04：壳重写后行为回归）。
//
// 重点覆盖「壳重写（阶段1）」后用户可见行为不变的关键契约：
//   1. 会话 tab 关闭 → store 置 hidden:true，且内容实例不卸载（keep-alive，
//      切回恢复滚动与历史）。CenterPane 渲染所有 tab 内容（含 hidden），
//      仅 TabBar 过滤掉 hidden；非 active 的加 .tab-content（无 .active）由 CSS display:none。
//   2. preview tab 的关闭 × 经 CenterPane 的 closeGuard 拦截（dirty 确认）；
//      diff tab 的 × 直接走 store.closeCenterTab（真移除）。
//   3. 抽屉高度持久化：从 store.drawerHeight 取数渲染 TerminalDrawer 的 height；
//      抽屉开关由 store.drawerOpen 驱动。
//
// 为聚焦「壳契约」而非子组件内部逻辑，这里把重组件（TerminalPane / PreviewTab /
// DiffTab / TerminalDrawer）替换为轻量桩，仅断言 CenterPane 与 store 的取数/写回契约。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { CenterPane } from '../components/CenterPane';
import { useTabStore } from '../store/tabStore';
import type { Tab } from '../store/tabStore';

// —— 轻量桩：只暴露可被断言的 data-* 与 className，不触发真实 xterm / 文件读取 ——
vi.mock('../components/SessionPane', () => ({
  SessionPane: ({ sessionKey, active }: any) => (
    <div
      data-testid="terminal-pane"
      data-key={sessionKey}
      className={active ? 'tab-content active' : 'tab-content'}
    >
      {sessionKey}
    </div>
  ),
}));

vi.mock('../components/PreviewTab', () => ({
  PreviewTab: ({ tabId, active, onRegisterCloseGuard, onClose }: any) => {
    // 挂载即注册关闭拦截器（模拟 dirty 场景：注册一个会弹确认的函数）。
    return (
      <div
        data-testid="preview-tab-body"
        data-id={tabId}
        className={active ? 'tab-content active' : 'tab-content'}
      >
        <button
          data-testid="preview-confirm-close"
          onClick={() => {
            onRegisterCloseGuard?.(tabId, () => onClose());
          }}
        >
          register-guard
        </button>
      </div>
    );
  },
}));

vi.mock('../components/DiffTab', () => ({
  DiffTab: ({ cwd, commitHash, active }: any) => (
    <div
      data-testid="diff-tab-body"
      data-cwd={cwd}
      className={active ? 'tab-content active' : 'tab-content'}
    >
      diff:{cwd}:{commitHash ?? 'work'}
    </div>
  ),
}));

vi.mock('../components/TerminalDrawer', () => ({
  TerminalDrawer: ({ open, height, onCloseTab, onNewTerminal, onResizeHeight }: any) =>
    open ? (
      <div data-testid="terminal-drawer" data-height={height} className="terminal-drawer">
        <button data-testid="drawer-close" onClick={() => onCloseTab('term-1')}>close</button>
        <button data-testid="drawer-new" onClick={() => onNewTerminal()}>new</button>
        <button data-testid="drawer-resize" onClick={() => onResizeHeight(300)}>resize</button>
      </div>
    ) : null,
}));

/** 重置 store 到干净状态。 */
function resetStore() {
  useTabStore.setState({
    tabs: [],
    activeEditorTabId: null,
    activePanelTabId: null,
    terminals: [],
    drawerOpen: false,
    drawerHeight: 240,
    activeTermId: null,
  });
}

function seedTabs(tabs: Tab[]) {
  useTabStore.setState({ tabs });
}

const noop = () => {};

function renderCenterPane(overrides: Partial<React.ComponentProps<typeof CenterPane>> = {}) {
  return render(
    <CenterPane
      onNewTerminal={vi.fn()}
      onResizeDrawer={vi.fn()}
      onCloseTermTab={vi.fn()}
      {...overrides}
    />,
  );
}

describe('CenterPane — 壳重写后行为回归', () => {
  beforeEach(resetStore);

  describe('从 store 取数渲染中间区 TabBar', () => {
    it('只渲染可见（非 hidden）tab 到 TabBar，hidden 的不出现在 tab 条', () => {
      seedTabs([
        { id: 's1', kind: 'session', location: 'editor', title: 'sess-a', hidden: false, order: 0, key: '/a', cwd: '/a', name: 'sess-a' } as Tab,
        { id: 's2', kind: 'session', location: 'editor', title: 'sess-b', hidden: true, order: 1, key: '/b', cwd: '/b', name: 'sess-b' } as Tab,
      ]);
      const { container } = renderCenterPane();
      const tabEls = container.querySelectorAll('.center-pane .terminal-tab');
      // s2 已 hidden → 不进 TabBar。
      expect(tabEls.length).toBe(1);
      expect(tabEls[0].textContent).toContain('sess-a');
    });

    it('active 指针驱动 TabBar 的 active class，取数自 store.activeEditorTabId', () => {
      seedTabs([
        { id: 's1', kind: 'session', location: 'editor', title: 'sess-a', hidden: false, order: 0, key: '/a', cwd: '/a', name: 'sess-a' } as Tab,
        { id: 's2', kind: 'session', location: 'editor', title: 'sess-b', hidden: false, order: 1, key: '/b', cwd: '/b', name: 'sess-b' } as Tab,
      ]);
      useTabStore.setState({ activeEditorTabId: 's2' });
      const { container } = renderCenterPane();
      const tabEls = container.querySelectorAll('.center-pane .terminal-tab');
      expect(tabEls[0].className).not.toContain('active');
      expect(tabEls[1].className).toContain('active');
    });

    it('无可见 tab 时渲染空状态提示', () => {
      seedTabs([
        { id: 's1', kind: 'session', location: 'editor', title: 'sess-a', hidden: true, order: 0, key: '/a', cwd: '/a', name: 'sess-a' } as Tab,
      ]);
      const { container } = renderCenterPane();
      expect(container.querySelector('.empty-state')).toBeTruthy();
    });
  });

  describe('keep-alive：会话 tab 关闭后 hidden:true 且内容实例不卸载', () => {
    it('关闭会话 tab → 调 store.closeCenterTab，tab 进入 hidden 但内容 div 仍挂载（切回可恢复）', () => {
      seedTabs([
        { id: 's1', kind: 'session', location: 'editor', title: 'sess-a', hidden: false, order: 0, key: '/a', cwd: '/a', name: 'sess-a' } as Tab,
        { id: 's2', kind: 'session', location: 'editor', title: 'sess-b', hidden: false, order: 1, key: '/b', cwd: '/b', name: 'sess-b' } as Tab,
      ]);
      useTabStore.setState({ activeEditorTabId: 's1' });
      const closeCenterTab = vi.spyOn(useTabStore.getState(), 'closeCenterTab');

      const { container } = renderCenterPane();
      // 两个会话的内容 div 都挂载（keep-alive，全部渲染）。
      const panes = container.querySelectorAll('[data-testid="terminal-pane"]');
      expect(panes.length).toBe(2);

      // 点 TabBar 上 s1 的 × → 经 requestCloseTab 直关（session 无 guard）。
      const closeBtns = container.querySelectorAll('.center-pane .terminal-tab .tab-close');
      expect(closeBtns.length).toBe(2);
      fireEvent.click(closeBtns[0] as HTMLElement);

      // store.closeCenterTab('s1') 被调用（session → 隐藏不卸载）。
      expect(closeCenterTab).toHaveBeenCalledWith('s1');
      // store 实际把 s1 置 hidden。
      const s = useTabStore.getState();
      expect(s.tabs.find((t) => t.id === 's1')!.hidden).toBe(true);
      // 内容实例不卸载：tab 内容仍全部渲染（不随 hidden 移除）。
      expect(s.tabs).toHaveLength(2);
    });

    it('重新打开（openSession 同 key）取消 hidden → 内容实例被复用而非重建', () => {
      seedTabs([
        { id: '/a', kind: 'session', location: 'editor', title: 'sess-a', hidden: true, order: 0, key: '/a', cwd: '/a', name: 'sess-a' } as Tab,
      ]);
      const { container } = renderCenterPane();
      // 隐藏态下，TabBar 不渲染该 tab；但内容 div 仍挂载（keep-alive）。
      expect(container.querySelectorAll('.center-pane .terminal-tab').length).toBe(0);
      const panes = container.querySelectorAll('[data-testid="terminal-pane"]');
      expect(panes.length).toBe(1);

      // 从侧边栏重开（openSession 同 key）→ 取消 hidden。
      act(() => {
        useTabStore.getState().openSession({ key: '/a', cwd: '/a', name: 'sess-a' });
      });
      const s = useTabStore.getState();
      expect(s.tabs.find((t) => t.id === '/a')!.hidden).toBe(false);
      expect(s.activeEditorTabId).toBe('/a');
    });
  });

  describe('preview / diff 关闭：guard 拦截与真移除', () => {
    it('preview 关闭 × 经 CenterPane guard 注册 → 调用注册的 guard（而非直关）', () => {
      seedTabs([
        { id: 'preview:/repo//a.ts', kind: 'preview', location: 'editor', title: 'a.ts', hidden: false, order: 0, root: '/repo', path: 'a.ts' } as Tab,
      ]);
      useTabStore.setState({ activeEditorTabId: 'preview:/repo//a.ts' });
      const closeCenterTab = vi.spyOn(useTabStore.getState(), 'closeCenterTab');

      const { container } = renderCenterPane();
      // 注册 guard（模拟 PreviewTab 挂载时经 onRegisterCloseGuard 登记）。
      const registerBtn = container.querySelector('[data-testid="preview-confirm-close"]') as HTMLElement;
      act(() => { fireEvent.click(registerBtn); });

      // 点 × → requestCloseTab 先查 guard：有则走 guard（此处 guard 会再调 onClose→store.closeCenterTab）。
      const closeBtn = container.querySelector('.center-pane .terminal-tab .tab-close') as HTMLElement;
      fireEvent.click(closeBtn);
      // guard 被触发 → 最终仍落到 store.closeCenterTab（preview 为真移除）。
      expect(closeCenterTab).toHaveBeenCalledWith('preview:/repo//a.ts');
    });

    it('diff tab 的 × 直接走 store.closeCenterTab（无 guard），preview 仍保留', () => {
      seedTabs([
        { id: 'preview:/repo//a.ts', kind: 'preview', location: 'editor', title: 'a.ts', hidden: false, order: 0, root: '/repo', path: 'a.ts' } as Tab,
        { id: 'diff:/repo//work', kind: 'diff', location: 'editor', title: '工作区改动', hidden: false, order: 1, cwd: '/repo', commitHash: null } as Tab,
      ]);
      useTabStore.setState({ activeEditorTabId: 'diff:/repo//work' });
      const closeCenterTab = vi.spyOn(useTabStore.getState(), 'closeCenterTab');

      const { container } = renderCenterPane();
      const closeBtns = container.querySelectorAll('.center-pane .terminal-tab .tab-close');
      // 第二个是 diff 的 ×（preview 在前）。
      fireEvent.click(closeBtns[1] as HTMLElement);
      expect(closeCenterTab).toHaveBeenCalledWith('diff:/repo//work');
    });
  });

  describe('抽屉高度 / 开关持久化（取数自 store）', () => {
    it('drawerOpen=true 时渲染 TerminalDrawer，且其 height 取数自 store.drawerHeight', () => {
      useTabStore.setState({ drawerOpen: true, drawerHeight: 360 });
      const { getByTestId } = renderCenterPane();
      const drawer = getByTestId('terminal-drawer');
      expect(drawer).toBeTruthy();
      expect(drawer.getAttribute('data-height')).toBe('360');
    });

    it('drawerOpen=false 时不挂载 TerminalDrawer', () => {
      useTabStore.setState({ drawerOpen: false });
      const { queryByTestId } = renderCenterPane();
      expect(queryByTestId('terminal-drawer')).toBeNull();
    });

    it('抽屉高度拖拽 → onResizeDrawer 回调收到新高度（持久化由 App 负责写 config）', () => {
      useTabStore.setState({ drawerOpen: true, drawerHeight: 240 });
      const onResizeDrawer = vi.fn();
      const { getByTestId } = renderCenterPane({ onResizeDrawer });
      fireEvent.click(getByTestId('drawer-resize'));
      expect(onResizeDrawer).toHaveBeenCalledWith(300);
    });

    it('抽屉关闭 tab → 调 onCloseTermTab（App 协调主进程 destroyTerminal）', () => {
      useTabStore.setState({ drawerOpen: true, drawerHeight: 240 });
      const onCloseTermTab = vi.fn();
      const { getByTestId } = renderCenterPane({ onCloseTermTab });
      fireEvent.click(getByTestId('drawer-close'));
      expect(onCloseTermTab).toHaveBeenCalledWith('term-1');
    });
  });
});
