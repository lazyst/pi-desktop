// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsPanel } from '../components/SettingsPanel';
import { defaultConfig } from '../../../main/config';
import type { TerminalProfile, AppConfig } from '../types';

const CONFIG: AppConfig = {
  ...defaultConfig(),
  defaultTerminalProfile: 'pwsh',
  terminalProfiles: {},
};

const PROFILES: TerminalProfile[] = [
  { id: 'pwsh', label: 'PowerShell', path: 'C:\\pwsh.exe', args: [], platform: 'windows' },
  { id: 'cmd', label: 'Command Prompt', path: 'C:\\cmd.exe', args: [], platform: 'windows' },
  { id: 'git-bash', label: 'Git Bash', path: 'C:\\git\\bash.exe', args: ['--login', '-i'], platform: 'windows' },
];

function setup(overrides: Partial<AppConfig> = {}, listProfiles = PROFILES) {
  const api = {
    getConfig: vi.fn().mockResolvedValue({ ...CONFIG, ...overrides }),
    setConfig: vi.fn().mockResolvedValue(undefined),
    listTerminalProfiles: vi.fn().mockResolvedValue(listProfiles),
  };
  (window as any).pi = api;
  render(<SettingsPanel onClose={() => {}} />);
  return api;
}

describe('SettingsPanel 终端设置', () => {
  it('终端 nav 项存在，点击后显示终端设置', async () => {
    setup();
    expect(screen.getByText('终端')).toBeInTheDocument();
    fireEvent.click(screen.getByText('终端'));
    expect(await screen.findByText('默认终端')).toBeInTheDocument();
    // 下拉里包含探测到的 profile 标签
    expect(screen.getByText('PowerShell')).toBeInTheDocument();
    expect(screen.getByText('Command Prompt')).toBeInTheDocument();
    expect(screen.getByText('Git Bash')).toBeInTheDocument();
    // 默认选中 pwsh（来自 config.defaultTerminalProfile）
    const select = screen.getByLabelText('默认终端') as HTMLSelectElement;
    expect(select.value).toBe('pwsh');
  });

  it('选择内置 profile → setConfig 被调用且 defaultTerminalProfile 正确', async () => {
    const api = setup();
    fireEvent.click(screen.getByText('终端'));
    const select = (await screen.findByLabelText('默认终端')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'git-bash' } });
    expect(api.setConfig).toHaveBeenCalledWith({ defaultTerminalProfile: 'git-bash' });
  });

  it('选择 custom → 显示自定义路径输入框', async () => {
    setup();
    fireEvent.click(screen.getByText('终端'));
    const select = (await screen.findByLabelText('默认终端')) as HTMLSelectElement;
    expect(screen.queryByLabelText('shell 路径')).toBeNull();
    fireEvent.change(select, { target: { value: 'custom' } });
    expect(await screen.findByLabelText('shell 路径')).toBeInTheDocument();
    expect(screen.getByLabelText('启动参数')).toBeInTheDocument();
    expect(screen.getByText('保存为默认')).toBeInTheDocument();
  });

  it('填路径 + 参数 + 保存 → setConfig 被调用且 terminalProfiles.custom 正确', async () => {
    const api = setup();
    fireEvent.click(screen.getByText('终端'));
    const select = (await screen.findByLabelText('默认终端')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'custom' } });
    fireEvent.change(await screen.findByLabelText('shell 路径'), {
      target: { value: 'C:\\Program Files\\Git\\bin\\bash.exe' },
    });
    fireEvent.change(screen.getByLabelText('启动参数'), {
      target: { value: '--login -i' },
    });
    fireEvent.click(screen.getByText('保存为默认'));
    await waitFor(() =>
      expect(api.setConfig).toHaveBeenCalledWith({
        defaultTerminalProfile: 'custom',
        terminalProfiles: {
          custom: { path: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'] },
        },
      }),
    );
  });

  it('自定义路径为空时保存 → 给出错误提示且不调用 setConfig', async () => {
    const api = setup();
    fireEvent.click(screen.getByText('终端'));
    const select = (await screen.findByLabelText('默认终端')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'custom' } });
    fireEvent.click(await screen.findByText('保存为默认'));
    expect(await screen.findByText('请填写 shell 路径')).toBeInTheDocument();
    expect(api.setConfig).not.toHaveBeenCalled();
  });
});
