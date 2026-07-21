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
    activeTabId: null,
    terminals: [],
  });
});

// 构造带统一终端 IPC 桩的 pi，供 App 统一 TabBar 终端测试使用。
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
    // 主进程在 spawnTerminal/destroyTerminal 后会经 term:list 主动推送完整列表
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
    // spawnTerminal 替代旧 createTerminal/createTerminalInAppWorkDir：
    // 返回统一 TerminalInfo 格式（含 key/name/type/status）。
    spawnTerminal: vi.fn(async () => {
      const info = { id: 't-1', key: 't-1', cwd: '/', title: 'PowerShell', name: 'PowerShell', type: 'shell', status: 'running' };
      // 模拟主进程 spawn 后广播 term:list（含新实例），对齐真实运行时。
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

describe('App 统一 TabBar 终端（Phase 2）', () => {
  it('点击标题条终端按钮 → spawnTerminal 被调用', async () => {
    const api = makeApi();
    render(<App />);
    const btn = screen.getByLabelText('新建终端') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() => expect(api.spawnTerminal).toHaveBeenCalled());
  });

  it('handleNewTerminal → spawnTerminal 被调用、openTerminal 创建 tab', async () => {
    const api = makeApi();
    render(<App />);
    fireEvent.click(screen.getByLabelText('新建终端'));

    await waitFor(() => expect(api.spawnTerminal).toHaveBeenCalled());
    // spawnTerminal 被传入 profile（defaultTerminalProfile 为 null 时取 profiles[0]）。
    const spawnCalls = (api as any).spawnTerminal.mock.calls;
    expect(spawnCalls.length).toBe(1);
    const req = spawnCalls[0][0];
    expect(req.profile.id).toBe(CONFIG.defaultTerminalProfile ?? 'pwsh');
    expect(api.listTerminalProfiles).toHaveBeenCalled();
    // 关键回归点：新建一次终端，中间区应「恰好一个」PowerShell tab，
    // 不会因「本地追加 + onTerminalList 推送」双路径而渲染出两个重复 tab。
    expect(api.onTerminalList).toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByText('PowerShell').length).toBe(1));
  });

  it('关闭终端 tab → 杀 PTY + 移除 tab，侧边栏计数更新', async () => {
    const api = makeApi();
    render(<App />);
    fireEvent.click(screen.getByLabelText('新建终端'));
    await waitFor(() => expect(api.spawnTerminal).toHaveBeenCalled());

    // TabBar 中的关闭按钮（class="tab-close"）。
    const closeBtn = document.querySelector('.tab-close') as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);

    // destroyTerminal 被调用，杀死 PTY
    await waitFor(() => expect(api.destroyTerminal).toHaveBeenCalled());
    // 标签从 DOM 移除（不再只是隐藏）
    await waitFor(() => {
      expect(screen.queryByText('PowerShell')).toBeNull();
    });
    // store.terminals 已清空（mock destroyTerminal 回调 _termListCb([])）
    expect(useTabStore.getState().terminals).toEqual([]);
    // tab 被真移除（不再是 hidden）
    expect(useTabStore.getState().tabs.length).toBe(0);
  });
});
