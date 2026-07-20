// @vitest-environment jsdom
//
// 集成终端：新建 / 切换 / 退出后激活指针正确迁移（issue 04 回归）。
//
// 壳重写后，集成终端的「选中 / 激活指针」语义统一由 store 持有：
//   - store.terminals（主进程 onTerminalList 推送）为实例列表单一事实来源；
//   - store.activeTermId 为当前激活终端指针；
//   - 点 tab 切换 → selectTab（panel location）→ activePanelTabId；
//     但 TerminalDrawer 直接订阅 activeTermId，故切换激活高亮看 activeTermId。
//   - 退出（onTerminalExit）→ removeTerminal：移除实例，若为激活态则迁移到剩余第一个或 null；
//   - 新建（createTerminal 返回 info）→ setActiveTermId(info.id) 置新终端为激活。
//
// 本文件断言「新建 / 切换 / 退出」三种操作后激活指针的精确迁移，确保后续阶段
// 在已稳定的壳上改动不会悄悄破坏交互。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { TerminalDrawer } from '../components/TerminalDrawer';
import { useTabStore } from '../store/tabStore';
import type { IntegratedTerminalInfo } from '../types';
import type { PiApi } from '../ipc';

// 无头 jsdom 无 WebGL 上下文，用轻量 mock 替换真实 WebglAddon。
vi.mock('@xterm/addon-webgl', () => {
  class WebglAddon {
    activate() {}
    onContextLoss() {}
    dispose() {}
  }
  return { WebglAddon };
});

function makeApi() {
  return {
    listSessions: vi.fn(), openSession: vi.fn(), terminate: vi.fn(),
    input: vi.fn(), resize: vi.fn(), onData: vi.fn(() => () => {}), onStatus: vi.fn(() => () => {}),
    onExit: vi.fn(), pickDirectory: vi.fn(), debug: vi.fn(),
    createTerminal: vi.fn(async () => ({ id: 'term-1', profileId: 'p', cwd: '/', title: 'shell' })),
    destroyTerminal: vi.fn(async () => {}),
    terminalInput: vi.fn(), terminalResize: vi.fn(),
    onTerminalData: vi.fn(() => () => {}), onTerminalExit: vi.fn(() => () => {}),
  } as unknown as PiApi;
}

const TERM: IntegratedTerminalInfo[] = [
  { id: 't-1', profileId: 'pwsh', cwd: '/a', title: 'PowerShell' },
  { id: 't-2', profileId: 'bash', cwd: '/b', title: 'bash' },
  { id: 't-3', profileId: 'pwsh', cwd: '/c', title: 'shell' },
];

function seed(activeId: string | null) {
  useTabStore.setState({ terminals: TERM, activeTermId: activeId });
}

function renderDrawer(overrides: Partial<React.ComponentProps<typeof TerminalDrawer>> = {}) {
  return render(
    <TerminalDrawer
      open={true}
      height={240}
      onSelectTab={vi.fn()}
      onCloseTab={vi.fn()}
      onNewTerminal={vi.fn()}
      onResizeHeight={vi.fn()}
      {...overrides}
    />,
  );
}

describe('集成终端激活指针迁移（store 为单一事实来源）', () => {
  beforeEach(() => {
    (window as any).pi = makeApi();
    useTabStore.setState({
      tabs: [],
      activeEditorTabId: null,
      activePanelTabId: null,
      terminals: [],
      drawerOpen: false,
      drawerHeight: 240,
      activeTermId: null,
    });
  });

  describe('新建（createTerminal 返回 info → setActiveTermId）', () => {
    it('新建终端后激活指针指向新终端 id', () => {
      seed('t-1');
      act(() => {
        useTabStore.getState().setActiveTermId('t-9');
      });
      expect(useTabStore.getState().activeTermId).toBe('t-9');
    });

    it('TerminalDrawer 把 store.activeTermId 反映到 TerminalTabBar 的 active class', () => {
      seed('t-2');
      const { container } = renderDrawer();
      const tabEls = container.querySelectorAll('.terminal-tab');
      expect(tabEls.length).toBe(3);
      // 第二个（t-2）应为 active。
      expect(tabEls[0].className).not.toContain('active');
      expect(tabEls[1].className).toContain('active');
      expect(tabEls[2].className).not.toContain('active');
    });
  });

  describe('切换（setActiveTermId 置新激活终端）', () => {
    it('setActiveTermId 写入 activeTermId，TerminalDrawer 据其把对应 tab 高亮为 active', () => {
      seed('t-1');
      const { container } = renderDrawer();
      // 初始：t-1 高亮。
      let tabEls = container.querySelectorAll('.terminal-tab');
      expect(tabEls[0].className).toContain('active');
      // 切换激活到 t-3（真实激活迁移路径：调用方在 onSelectTab 后调 setActiveTermId）。
      act(() => {
        useTabStore.getState().setActiveTermId('t-3');
      });
      // TerminalDrawer 订阅 store.activeTermId，高亮应追随迁移到 t-3。
      tabEls = container.querySelectorAll('.terminal-tab');
      expect(tabEls[0].className).not.toContain('active');
      expect(tabEls[2].className).toContain('active');
      expect(useTabStore.getState().activeTermId).toBe('t-3');
    });

    it('TerminalDrawer 的 tab 点击回调 → onSelectTab(id)（调用方据其写 store 激活）', () => {
      seed('t-1');
      const onSelectTab = vi.fn();
      const { container } = renderDrawer({ onSelectTab });
      const tabEls = container.querySelectorAll('.terminal-tab');
      fireEvent.click(tabEls[2] as HTMLElement);
      expect(onSelectTab).toHaveBeenCalledWith('t-3');
    });
  });

  describe('退出（onTerminalExit → removeTerminal）', () => {
    it('退出激活终端 → 激活指针迁移到剩余第一个', () => {
      seed('t-2');
      act(() => {
        useTabStore.getState().removeTerminal('t-2');
      });
      const s = useTabStore.getState();
      expect(s.terminals.map((t) => t.id)).toEqual(['t-1', 't-3']);
      // 激活态迁移到剩余第一个（t-1）。
      expect(s.activeTermId).toBe('t-1');
    });

    it('退出最后一个终端 → 激活指针置 null', () => {
      useTabStore.setState({ terminals: [TERM[0]], activeTermId: 't-1' });
      act(() => {
        useTabStore.getState().removeTerminal('t-1');
      });
      const s = useTabStore.getState();
      expect(s.terminals).toHaveLength(0);
      expect(s.activeTermId).toBeNull();
    });

    it('退出非激活终端 → 激活指针不变', () => {
      seed('t-1');
      act(() => {
        useTabStore.getState().removeTerminal('t-3');
      });
      expect(useTabStore.getState().activeTermId).toBe('t-1');
    });

    it('TerminalDrawer 渲染的终端 tab 数量随 store.terminals 减少', () => {
      seed('t-1');
      const { container } = renderDrawer();
      expect(container.querySelectorAll('.terminal-tab').length).toBe(3);
      act(() => {
        useTabStore.getState().removeTerminal('t-3');
      });
      // 组件订阅 store.terminals，移除后实时反映为 2 个 tab。
      expect(container.querySelectorAll('.terminal-tab').length).toBe(2);
    });
  });
});
