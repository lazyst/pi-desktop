// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import App from '../App';
import { defaultConfig } from '../../../main/config';

const CONFIG = defaultConfig();

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
    createTerminal: vi.fn(async () => ({ id: 't-1', profileId: 'pwsh', cwd: '/x', title: 'PowerShell' })),
    destroyTerminal: vi.fn().mockResolvedValue(undefined),
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

  it('handleNewTerminal → createTerminal 被调用、terminals 增加、activeTermId 设置', async () => {
    const api = makeApi();
    render(<App />);
    // 先打开抽屉，再点「新建终端」按钮（位于抽屉 tab 条右侧）。
    fireEvent.click(screen.getByLabelText('终端'));
    const newBtn = screen.getByLabelText('新建终端') as HTMLButtonElement;
    fireEvent.click(newBtn);

    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());
    // createTerminal 被传入 profile 与 cwd。
    const call = api.createTerminal.mock.calls[0] as unknown as [{ profile: { id: string }; cwd: string }];
    const req = call[0];
    expect(req.profile.id).toBe(CONFIG.defaultTerminalProfile ?? 'pwsh');
    expect(api.listTerminalProfiles).toHaveBeenCalled();
    // 抽屉内出现一个 integrated terminal host（keep-alive 渲染）。
    expect(screen.getAllByText('PowerShell').length).toBeGreaterThan(0);
  });

  it('关闭 tab → destroyTerminal 被调用、terminals 减少，且自动收起（最后一个）', async () => {
    const api = makeApi();
    render(<App />);
    fireEvent.click(screen.getByLabelText('终端'));
    fireEvent.click(screen.getByLabelText('新建终端'));
    // 等到终端创建
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());

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
    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled());

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
