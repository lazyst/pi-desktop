// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { getTheme, setTheme, onThemeChange } from '../theme';

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('setTheme applies the theme to <html> and persists it', () => {
    setTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('pi-desktop:theme')).toBe('light');
    expect(getTheme()).toBe('light');

    setTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('pi-desktop:theme')).toBe('dark');
    expect(getTheme()).toBe('dark');
  });

  it('notifies subscribers when the theme changes', () => {
    const seen: string[] = [];
    const off = onThemeChange((t) => seen.push(t));
    setTheme('light');
    setTheme('dark');
    off();
    expect(seen).toEqual(['light', 'dark']);
  });
});
