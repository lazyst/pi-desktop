// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { TerminalDrawer } from '../components/TerminalDrawer';
import { useTabStore } from '../store/tabStore';
import type { PiApi } from '../ipc';

// 无头 jsdom 无 WebGL 上下文，真实 WebglAddon 在 mount() 激活时会抛错并污染测试输出。
// 用轻量 mock 替换，只验证渲染器加载调用、不触发真实 GPU。
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
    // 集成终端 IPC 桩
    createTerminal: vi.fn(async () => ({ id: 'term-1', profileId: 'p', cwd: '/', title: 'shell' })),
    destroyTerminal: vi.fn(async () => {}),
    terminalInput: vi.fn(), terminalResize: vi.fn(),
    onTerminalData: vi.fn(() => () => {}), onTerminalExit: vi.fn(() => () => {}),
  } as unknown as PiApi;
}

const tabs = [
  { id: 'term-1', title: 'PowerShell' },
  { id: 'term-2', title: 'bash' },
];

// 把测试用的轻量 tab 列表装入 store（issue 03 后 TerminalDrawer 直接从 store 取
// terminals / activeTermId，不再透传 tabs / activeId props）。
function seedStore(activeId: string) {
  useTabStore.setState({
    terminals: tabs.map((t) => ({ id: t.id, profileId: 'p', cwd: '/', title: t.title })),
    tabs: tabs.map((t, i) => ({
      id: t.id, kind: 'integrated-terminal', location: 'panel', title: t.title,
      hidden: false, order: i, cwd: '/',
    })),
    activeTermId: activeId,
  });
}

describe('TerminalDrawer', () => {
  it('does not render when open is false', () => {
    const api = makeApi();
    (window as any).pi = api;
    seedStore('term-1');
    const { queryByTestId } = render(
      <TerminalDrawer
        open={false}
        height={200}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTerminal={vi.fn()}
        onResizeHeight={vi.fn()}
      />,
    );
    expect(queryByTestId('terminal-drawer')).toBeNull();
  });

  it('renders the tabbar and at least one integrated terminal pane when open', () => {
    const api = makeApi();
    (window as any).pi = api;
    seedStore('term-1');
    const { container, getByTestId } = render(
      <TerminalDrawer
        open={true}
        height={200}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTerminal={vi.fn()}
        onResizeHeight={vi.fn()}
      />,
    );
    expect(getByTestId('terminal-drawer')).toBeTruthy();
    expect(container.querySelector('.terminal-tabbar')).toBeTruthy();
    // 所有 tab 的 IntegratedTerminalPane 都渲染（keep-alive），非 active 的 hidden。
    const hosts = container.querySelectorAll('.integrated-terminal-host');
    expect(hosts.length).toBe(2);
    // active 的那个 host 带 active class，data-terminal 正确。
    const activeHost = container.querySelector('.integrated-terminal-host.active') as HTMLElement;
    expect(activeHost).toBeTruthy();
    expect(activeHost.getAttribute('data-terminal')).toBe('term-1');
  });

  it('dragging the resizer calls onResizeHeight with a clamped value', () => {
    const api = makeApi();
    (window as any).pi = api;
    const onResizeHeight = vi.fn();
    const { container } = render(
      <TerminalDrawer
        open={true}
        height={300}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTerminal={vi.fn()}
        onResizeHeight={onResizeHeight}
      />,
    );
    const resizer = container.querySelector('.terminal-drawer-resizer') as HTMLElement;
    expect(resizer).toBeTruthy();

    // 向上拖 80px → 高度 300 + 80 = 380，应被回调。
    act(() => {
      fireEvent.mouseDown(resizer, { clientY: 500 });
      fireEvent.mouseMove(document, { clientY: 420 });
    });
    expect(onResizeHeight).toHaveBeenCalled();
    const last = onResizeHeight.mock.calls[onResizeHeight.mock.calls.length - 1][0];
    expect(last).toBe(380);

    // 松开鼠标，移除监听。
    act(() => {
      fireEvent.mouseUp(document);
    });
    onResizeHeight.mockClear();
    act(() => {
      fireEvent.mouseMove(document, { clientY: 100 });
    });
    expect(onResizeHeight).not.toHaveBeenCalled();
  });

  it('clamps the dragged height to the [120, 600] range', () => {
    const api = makeApi();
    (window as any).pi = api;
    seedStore('term-1');
    const onResizeHeight = vi.fn();
    const { container } = render(
      <TerminalDrawer
        open={true}
        height={300}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTerminal={vi.fn()}
        onResizeHeight={onResizeHeight}
      />,
    );
    const resizer = container.querySelector('.terminal-drawer-resizer') as HTMLElement;
    // 向下猛拖 1000px：300 - 1000 = -700 → 夹到下限 120。
    act(() => {
      fireEvent.mouseDown(resizer, { clientY: 1000 });
      fireEvent.mouseMove(document, { clientY: 2000 });
    });
    const last = onResizeHeight.mock.calls[onResizeHeight.mock.calls.length - 1][0];
    expect(last).toBe(120);
  });

  it('panel 区拖拽重排 → 调 store.reorderTabs("panel", ...) 仅改 order、不动集成终端渲染实例', () => {
    const api = makeApi();
    (window as any).pi = api;
    seedStore('term-1');
    const { container } = render(
      <TerminalDrawer
        open={true}
        height={200}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTerminal={vi.fn()}
        onResizeHeight={vi.fn()}
      />,
    );
    // 拖拽前：tabbar 顺序跟随 store.terminals（term-1, term-2）。
    let els = container.querySelectorAll('.terminal-tabbar .terminal-tab');
    expect(els[0].textContent).toContain('PowerShell');
    expect(els[1].textContent).toContain('bash');
    // 集成终端 host 全部挂载（keep-alive）。
    expect(container.querySelectorAll('.integrated-terminal-host').length).toBe(2);

    // 模拟父层（TerminalDrawer 的 onReorder）调 store.reorderTabs('panel', 新顺序)。
    act(() => {
      useTabStore.getState().reorderTabs('panel', ['term-2', 'term-1']);
    });

    // 视觉顺序跟随新 order（父层把 terminals 按 order 排序后传入 TerminalTabBar）。
    els = container.querySelectorAll('.terminal-tabbar .terminal-tab');
    expect(els[0].textContent).toContain('bash');
    expect(els[1].textContent).toContain('PowerShell');
    // 集成终端渲染实例不重建：仍 2 个 host，data-terminal 集合不变。
    const hosts = container.querySelectorAll('.integrated-terminal-host');
    expect(hosts.length).toBe(2);
    const ids = Array.from(hosts).map((h) => h.getAttribute('data-terminal')).sort();
    expect(ids).toEqual(['term-1', 'term-2']);
  });
});
