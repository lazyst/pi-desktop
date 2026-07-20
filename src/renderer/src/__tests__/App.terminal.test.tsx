// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import App from '../App';
import { defaultConfig } from '../../../main/config';
import { useTabStore } from '../store/tabStore';

const CONFIG = defaultConfig();

// store 是模块级单例，每个用例 render(<App/>) 前重置，保证从干净状态开始
// （对齐重构前 App 的 useState 每实例独立；见 issue 03 状态收编进 store）。
beforeEach(() => {
  useTabStore.setState({
    tabs: [],
    activeEditorTabId: null,
    activePanelTabId: null,
    terminals: [],
    drawerOpen: false,
    drawerHeight: CONFIG.terminalDrawerHeight,
    activeTermId: null,
  });
});

// 构造带集成终端 IPC 桩的 pi，供 App 终端抽屉测试使用。
function makeApi(overrides: Record<string, unknown> = {}) {
  const api = {
    listSessions: vi.fn().mockResolvedValue([]),
    openSession: vi.fn(),
    terminate: vi.fn(),
    input: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(() => () => {}),
    onStatus: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    onIndex: vi.fn(() => () => {}),
    onRelink: vi.fn(() => () => {}),
    onTerminalExit: vi.fn(() => () => {}),
    // 主进程在 createTerminal/destroyTerminal 后会经 term:list 主动推送完整列表
    // （单一事实来源，见 App 的 onTerminalList 订阅）。preload 的解构为 cb(m.list)，
    // 故桩也按 m.list 解构，对齐真实契约（避免 setTerminals 收到非数组而崩溃）。
    onTerminalList: vi.fn((cb: (list: any[]) => void) => {
      (api as any)._termListCb = cb;
      return () => { (api as any)._termListCb = null; };
    }),
    pickDirectory: vi.fn(),
    debug: vi.fn(),
    getConfig: vi.fn().mockResolvedValue(CONFIG),
    setConfig: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn(),
    deleteMany: vi.fn(),
    clearDirectory: vi.fn(),
    listTerminalProfiles: vi.fn().mockResolvedValue([
      { id: 'pwsh', name: 'PowerShell', shell: 'pwsh', args: [] },
      { id: 'bash', name: 'bash', shell: 'bash', args: [] },
    ]),
    createTerminal: vi.fn(async () => {
      const info = { id: 't-1', profileId: 'pwsh', cwd: '/x', title: 'PowerShell' };
      // 模拟主进程 create 后广播 term:list（含新实例），对齐真实运行时。
      (api as any)._termListCb?.([info]);
      return info;
    }),
    // 无激活会话时 App.handleNewTerminal 走「应用工作目录」分支，需有对应桩。
    createTerminalInAppWorkDir: vi.fn(async () => {
      const info = { id: 't-1', profileId: 'pwsh', cwd: '/app', title: 'PowerShell' };
      (api as any)._termListCb?.([info]);
      return info;
    }),
    destroyTerminal: vi.fn(async (id: string) => {
      // 模拟主进程 destroy 后广播 term:list（清空），对齐真实运行时。
      (api as any)._termListCb?.([]);
      return undefined;
    }),
    terminalInput: vi.fn(),
    terminalResize: vi.fn(),
    onTerminalData: vi.fn(() => () => {}),
    ...overrides,
  };
  (window as any).pi = api;
  return api;
}

describe('App 集成终端抽屉（T6）', () => {
  it('点击标题条终端按钮 → 抽屉打开', () => {
    const api = makeApi();
    render(<App />);
    const btn = screen.getByLabelText('终端') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-label')).toBe('终端');
    expect(screen.queryByTestId('terminal-drawer')).toBeNull();
    fireEvent.click(btn);
    expect(screen.getByTestId('terminal-drawer')).toBeTruthy();
    // 再次点击 → 收起
    fireEvent.click(btn);
    expect(screen.queryByTestId('terminal-drawer')).toBeNull();
  });

  it('标题条终端按钮在激活时带 active 类', () => {
    const api = makeApi();
    render(<App />);
    const btn = screen.getByLabelText('终端') as HTMLButtonElement;
    expect(btn.className).not.toContain('active');
    fireEvent.click(btn);
    expect(btn.className).toContain('active');
  });

  it('handleNewTerminal → createTerminal 被调用、经 onTerminalList 推送渲染恰好一个 tab、activeTermId 设置', async () => {
    const api = makeApi();
    render(<App />);
    // 先打开抽屉，再点「新建终端」按钮（位于抽屉 tab 条右侧）。
    fireEvent.click(screen.getByLabelText('终端'));
    const newBtn = screen.getByLabelText('新建终端') as HTMLButtonElement;
    fireEvent.click(newBtn);

    await waitFor(() => expect(api.createTerminal.mock.calls.length + api.createTerminalInAppWorkDir.mock.calls.length).toBeGreaterThan(0));
    // createTerminal 被传入 profile 与 cwd（无激活会话时走 createTerminalInAppWorkDir 分支，同样校验 profile）。
    const createCalls = api.createTerminal.mock.calls;
    const createAppCalls = api.createTerminalInAppWorkDir.mock.calls;
    expect(createCalls.length + createAppCalls.length).toBe(1);
    const req = (createCalls.length ? createCalls : createAppCalls)[0] as unknown as [{ profile: { id: string }; cwd?: string }];
    expect(req[0].profile.id).toBe(CONFIG.defaultTerminalProfile ?? 'pwsh');
    expect(api.listTerminalProfiles).toHaveBeenCalled();
    // 关键回归点：新建一次终端，抽屉里应「恰好一个」PowerShell tab，
    // 不会因「本地追加 + onTerminalList 推送」双路径而渲染出两个重复 tab。
    expect(api.onTerminalList).toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByText('PowerShell').length).toBe(1));
  });

  it('关闭 tab → destroyTerminal 被调用、terminals 减少，且自动收起（最后一个）', async () => {
    const api = makeApi();
    render(<App />);
    fireEvent.click(screen.getByLabelText('终端'));
    fireEvent.click(screen.getByLabelText('新建终端'));
    // 等到终端创建（无激活会话时走 createTerminalInAppWorkDir 分支）。
    await waitFor(() => expect(api.createTerminal.mock.calls.length + api.createTerminalInAppWorkDir.mock.calls.length).toBeGreaterThan(0));

    // 抽屉内应有一个终端 tab 的关闭按钮
    const closeBtn = screen.getByLabelText('关闭终端') as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);
    expect(api.destroyTerminal).toHaveBeenCalledWith('t-1');
    // 关掉最后一个 → 抽屉收起
    await waitFor(() => expect(screen.queryByTestId('terminal-drawer')).toBeNull());
  });

  it('抽屉高度拖拽 → setConfig 被调用（terminalDrawerHeight）', async () => {
    const api = makeApi();
    render(<App />);
    fireEvent.click(screen.getByLabelText('终端'));
    fireEvent.click(screen.getByLabelText('新建终端'));
    await waitFor(() => expect(api.createTerminal.mock.calls.length + api.createTerminalInAppWorkDir.mock.calls.length).toBeGreaterThan(0));

    const resizer = document.querySelector('.terminal-drawer-resizer') as HTMLElement;
    expect(resizer).toBeTruthy();
    act(() => {
      fireEvent.mouseDown(resizer, { clientY: 500 });
      fireEvent.mouseMove(document, { clientY: 400 });
      fireEvent.mouseUp(document);
    });
    // 向上拖 100px：drawerHeight(=CONFIG.terminalDrawerHeight) + 100 → 回写 config。
    expect(api.setConfig).toHaveBeenCalled();
    const partial = api.setConfig.mock.calls[api.setConfig.mock.calls.length - 1][0];
    expect(partial).toHaveProperty('terminalDrawerHeight');
  });
});
