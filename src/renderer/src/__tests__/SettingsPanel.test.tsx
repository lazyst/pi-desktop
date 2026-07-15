// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsPanel } from '../components/SettingsPanel';
import { defaultConfig } from '../../../main/config';

const CONFIG = defaultConfig();

describe('SettingsPanel', () => {
  it('renders a close-behavior segmented control defaulting to minimize-to-tray', async () => {
    const api = {
      getConfig: vi.fn().mockResolvedValue(CONFIG),
      setConfig: vi.fn().mockResolvedValue(undefined),
    };
    (window as any).pi = api;
    render(<SettingsPanel onClose={() => {}} />);

    expect(await screen.findByText('关闭按钮')).toBeInTheDocument();
    const closeBtn = screen.getByText('直接关闭');
    const minimizeBtn = screen.getByText('最小化到托盘');
    expect(closeBtn).toBeInTheDocument();
    expect(minimizeBtn).toBeInTheDocument();

    // default config is minimize-to-tray → that segment is the active one
    expect(minimizeBtn.getAttribute('aria-checked')).toBe('true');
    expect(closeBtn.getAttribute('aria-checked')).toBe('false');
  });

  it('switching close behavior persists via setConfig', async () => {
    const api = {
      getConfig: vi.fn().mockResolvedValue(CONFIG),
      setConfig: vi.fn().mockResolvedValue(undefined),
    };
    (window as any).pi = api;
    render(<SettingsPanel onClose={() => {}} />);

    const closeBtn = await screen.findByText('直接关闭');
    fireEvent.click(closeBtn);
    expect(api.setConfig).toHaveBeenCalledWith({ closeBehavior: 'close' });
    await waitFor(() =>
      expect(screen.getByText('直接关闭').getAttribute('aria-checked')).toBe('true'),
    );

    fireEvent.click(screen.getByText('最小化到托盘'));
    expect(api.setConfig).toHaveBeenCalledWith({ closeBehavior: 'minimize-to-tray' });
    await waitFor(() =>
      expect(screen.getByText('最小化到托盘').getAttribute('aria-checked')).toBe('true'),
    );
  });
});
