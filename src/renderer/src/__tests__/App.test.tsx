// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import App from '../App';
import { defaultConfig } from '../../../main/config';

const CONFIG = defaultConfig();

describe('App', () => {
  it('passes only disk sessions to the sidebar (no live merge)', async () => {
    const api = {
      listSessions: vi.fn().mockResolvedValue([]),
      openSession: vi.fn(),
      terminate: vi.fn(),
      input: vi.fn(), resize: vi.fn(),
      onData: vi.fn(), onStatus: vi.fn(), onExit: vi.fn(), onIndex: vi.fn(), onRelink: vi.fn(),
      pickDirectory: vi.fn(), debug: vi.fn(), getConfig: vi.fn().mockResolvedValue(CONFIG),
    };
    (window as any).pi = api;
    render(<App />);
    // onIndex 被订阅（用于后续晋升），初始 listSessions 被调用
    expect(api.onIndex).toHaveBeenCalled();
    expect(api.listSessions).toHaveBeenCalled();
    // 侧边栏存在，但空列表时不渲染任何 session-item
    expect(await screen.findByText('会话', { exact: true })).toBeInTheDocument();
    expect(screen.queryByText('live-xyz')).toBeNull();
  });

  it('batch delete: select sessions then confirm calls pi.deleteMany', async () => {
    const groups = [{ cwd: 'C:\\Users\\hcz\\project', sessions: [{ key: 'k1', name: 's1', time: 't' }, { key: 'k2', name: 's2', time: 't' }] }];
    // 左侧栏只展示“添加目录”注册的目录下的会话，需把 cwd 纳入 addedDirs。
    const cfgWithDir = { ...CONFIG, addedDirs: ['C:\\Users\\hcz\\project'] };
    const api = {
      listSessions: vi.fn().mockResolvedValue(groups),
      openSession: vi.fn(), terminate: vi.fn(), deleteSession: vi.fn(),
      deleteMany: vi.fn(), clearDirectory: vi.fn(),
      input: vi.fn(), resize: vi.fn(),
      onData: vi.fn(), onStatus: vi.fn(), onExit: vi.fn(), onIndex: vi.fn(), onRelink: vi.fn(),
      pickDirectory: vi.fn(), debug: vi.fn(), getConfig: vi.fn().mockResolvedValue(cfgWithDir),
    };
    (window as any).pi = api;
    render(<App />);
    // 初始 listSessions 加载出磁盘会话（避免被异步重置）
    await screen.findByText('s1');

    // 进入多选模式
    fireEvent.click(screen.getByText('管理'));
    expect(await screen.findByText('已选 0 项')).toBeInTheDocument();

    // 勾选 k1
    const item1 = screen.getByText('s1').closest('.session-item')!;
    fireEvent.click(item1);
    expect(await screen.findByText('已选 1 项')).toBeInTheDocument();

    // 点击顶部“删除”打开确认框（用 data-action 区分 header 按钮与确认按钮）
    fireEvent.click(document.querySelector('[data-action="batch-delete"]')!);
    expect(await screen.findByText(/确定删除选中的 1 个会话/)).toBeInTheDocument();

    // 确认 → 调用 pi.deleteMany(['k1'])
    const dialog = document.querySelector('.confirm-dialog')!;
    fireEvent.click(dialog.querySelector('.btn-danger')!);
    expect(api.deleteMany).toHaveBeenCalledWith(['k1']);
  });

  it('clear directory: confirm calls pi.clearDirectory with the cwd', async () => {
    const cwd = 'C:\\Users\\hcz\\project';
    const groups = [{ cwd, sessions: [{ key: 'k1', name: 's1', time: 't' }] }];
    // 左侧栏只展示“添加目录”注册的目录下的会话，需把 cwd 纳入 addedDirs。
    const cfgWithDir = { ...CONFIG, addedDirs: [cwd] };
    const api = {
      listSessions: vi.fn().mockResolvedValue(groups),
      openSession: vi.fn(), terminate: vi.fn(), deleteSession: vi.fn(),
      deleteMany: vi.fn(), clearDirectory: vi.fn(),
      input: vi.fn(), resize: vi.fn(),
      onData: vi.fn(), onStatus: vi.fn(), onExit: vi.fn(), onIndex: vi.fn(), onRelink: vi.fn(),
      pickDirectory: vi.fn(), debug: vi.fn(), getConfig: vi.fn().mockResolvedValue(cfgWithDir),
    };
    (window as any).pi = api;
    render(<App />);
    await screen.findByText('s1');

    // 点击组 header 的“清空”
    fireEvent.click(screen.getByLabelText(`清空 ${cwd}`));
    expect(await screen.findByText(/确定清空目录/)).toBeInTheDocument();

    // 确认 → 调用 pi.clearDirectory(cwd)
    const dialog = document.querySelector('.confirm-dialog')!;
    fireEvent.click(dialog.querySelector('.btn-danger')!);
    expect(api.clearDirectory).toHaveBeenCalledWith(cwd);
  });
});
