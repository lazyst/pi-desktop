// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { getTheme, setTheme, onThemeChange, initTheme } from '../theme';
import { defaultConfig } from '../../../main/config';

const BASE = defaultConfig();

describe('theme', () => {
  let written: any[];
  beforeEach(() => {
    written = [];
    document.documentElement.removeAttribute('data-theme');
    (window as any).pi = {
      getConfig: async () => JSON.parse(JSON.stringify(BASE)),
      // 返回 Promise，使 setTheme 里的 .catch 不报错；同时记录写入供断言。
      setConfig: vi.fn().mockImplementation((partial: any) => {
        written.push(partial);
        return Promise.resolve();
      }),
    };
  });

  it('setTheme applies the theme to <html> and persists via config IPC (not localStorage)', () => {
    setTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(getTheme()).toBe('light');
    expect(written).toContainEqual({ theme: 'light' });
    expect(localStorage.getItem('pi-desktop:theme')).toBeNull();

    setTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(getTheme()).toBe('dark');
    expect(written).toContainEqual({ theme: 'dark' });
  });

  it('notifies subscribers when the theme changes', () => {
    const seen: string[] = [];
    const off = onThemeChange((t) => seen.push(t));
    setTheme('light');
    setTheme('dark');
    off();
    expect(seen).toEqual(['light', 'dark']);
  });

  it('initTheme applies the persisted theme from config', async () => {
    (window as any).pi.getConfig = async () => ({ ...BASE, theme: 'light' });
    await initTheme();
    expect(getTheme()).toBe('light');
  });
});
