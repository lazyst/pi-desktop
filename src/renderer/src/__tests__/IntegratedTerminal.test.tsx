// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { TerminalDrawer } from '../components/TerminalDrawer';
import { IntegratedPane } from '../components/IntegratedPane';
import { XtermTerminal } from '../components/XtermTerminal';
import { IntegratedChannel } from '../components/terminalChannel';
import { useTabStore } from '../store/tabStore';
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

const tabs = [
  { id: 'term-1', title: 'PowerShell' },
  { id: 'term-2', title: 'bash' },
];

// issue 03 后 TerminalDrawer 直接从 store 取 terminals / activeTermId，
// 测试前把 terminals 装入 store（含 IntegratedTerminalInfo 必填字段）。
beforeEach(() => {
  useTabStore.setState({
    terminals: tabs.map((t) => ({ id: t.id, profileId: 'p', cwd: '/', title: t.title })),
    activeTermId: 'term-1',
  });
});

describe('TerminalDrawer drag listeners (no leak)', () => {
  // 抓取 document 的真实原生实现，避免 spy 自递归。
  const nativeAdd = document.addEventListener.bind(document);
  const nativeRemove = document.removeEventListener.bind(document);
  let addSpy: ReturnType<typeof vi.spyOn>;
  let removeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (window as any).pi = makeApi();
    addSpy = vi.spyOn(document, 'addEventListener');
    removeSpy = vi.spyOn(document, 'removeEventListener');
  });

  afterEach(() => {
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('adds mousemove/mouseup on resizer mousedown and removes them on mouseup (paired by handler identity)', () => {
    const { container } = render(
      <TerminalDrawer
        open={true}
        height={300}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewTerminal={vi.fn()}
        onResizeHeight={vi.fn()}
      />,
    );
    const resizer = container.querySelector('.terminal-drawer-resizer') as HTMLElement;

    // 仅关注本组件挂在 document 上的 mousemove / mouseup（忽略其他测试基础设施监听）。
    const recorded: Array<{ type: string; handler: unknown; kind: 'add' | 'remove' }> = [];
    addSpy.mockImplementation((type: any, handler: any, opts?: any) => {
      if (type === 'mousemove' || type === 'mouseup') recorded.push({ type, handler, kind: 'add' });
      return nativeAdd(type, handler, opts);
    });
    removeSpy.mockImplementation((type: any, handler: any, opts?: any) => {
      if (type === 'mousemove' || type === 'mouseup') recorded.push({ type, handler, kind: 'remove' });
      return nativeRemove(type, handler, opts);
    });

    act(() => {
      fireEvent.mouseDown(resizer, { clientY: 500 });
    });

    // mousedown 应挂上 mousemove + mouseup 各一次。
    const adds = recorded.filter((r) => r.kind === 'add');
    expect(adds.filter((r) => r.type === 'mousemove').length).toBe(1);
    expect(adds.filter((r) => r.type === 'mouseup').length).toBe(1);

    act(() => {
      fireEvent.mouseUp(document);
    });

    // mouseup 后应对称移除，且移除的 handler 与添加的 handler 是同一引用（无泄漏）。
    const removes = recorded.filter((r) => r.kind === 'remove');
    expect(removes.filter((r) => r.type === 'mousemove').length).toBe(1);
    expect(removes.filter((r) => r.type === 'mouseup').length).toBe(1);
    const addedMove = adds.find((r) => r.type === 'mousemove')!.handler;
    const removedMove = removes.find((r) => r.type === 'mousemove')!.handler;
    const addedUp = adds.find((r) => r.type === 'mouseup')!.handler;
    const removedUp = removes.find((r) => r.type === 'mouseup')!.handler;
    expect(removedMove).toBe(addedMove);
    expect(removedUp).toBe(addedUp);
  });
});

describe('IntegratedPane constructs XtermTerminal with IntegratedChannel', () => {
  beforeEach(() => {
    (window as any).pi = makeApi();
  });

  it('constructs an XtermTerminal whose channel is an IntegratedChannel instance', () => {
    // 拦截 mount 以捕获实例，并避免真实 xterm open（jsdom 无真实 DOM 测量）。
    // XtermTerminal 的 channel 是实例属性，可从 mount 的 this 读取，直接验证类型。
    let capturedChannel: unknown = undefined;
    const mountSpy = vi.spyOn(XtermTerminal.prototype, 'mount').mockImplementation(function (this: any) {
      capturedChannel = this.channel;
      this.mounted = true;
    });

    const { container } = render(
      <IntegratedPane terminalId="term-42" active={true} />,
    );

    // host div 渲染且带 data-terminal（标识该集成终端实例）。
    const host = container.querySelector('.integrated-terminal-host') as HTMLElement;
    expect(host).toBeTruthy();
    expect(host.getAttribute('data-terminal')).toBe('term-42');

    // XtermTerminal 被构造（mount 被调用），且注入的 channel 是 IntegratedChannel 实例。
    expect(mountSpy).toHaveBeenCalled();
    expect(capturedChannel).toBeInstanceOf(IntegratedChannel);

    mountSpy.mockRestore();
  });
});
