import { describe, it, expect } from 'vitest';
import { defaultConfig, parseConfig, mergeConfig } from '../config';

describe('config (pure)', () => {
  it('defaultConfig has the expected shape', () => {
    const c = defaultConfig();
    expect(c.theme).toBe('dark');
    expect(c.pinnedDirs).toEqual([]);
    expect(c.window.maximized).toBe(false);
    expect(c.window.bounds.width).toBe(1100);
    expect(c.sidebarWidth).toBe(280);
    expect(c.closeBehavior).toBe('minimize-to-tray');
  });

  it('parseConfig returns defaults for null/empty', () => {
    expect(parseConfig(null)).toEqual(defaultConfig());
    expect(parseConfig('')).toEqual(defaultConfig());
  });

  it('parseConfig falls back to defaults on corrupt JSON without throwing', () => {
    const c = parseConfig('{ not valid json');
    expect(c).toEqual(defaultConfig());
  });

  it('parseConfig merges a valid partial over defaults', () => {
    const c = parseConfig(JSON.stringify({ theme: 'light', sidebarWidth: 320 }));
    expect(c.theme).toBe('light');
    expect(c.sidebarWidth).toBe(320);
    expect(c.closeBehavior).toBe('minimize-to-tray'); // untouched
    expect(c.window.bounds.width).toBe(1100); // untouched
  });

  it('mergeConfig shallow-merges top-level keys (window replaced wholesale)', () => {
    const base = defaultConfig();
    const next = mergeConfig(base, {
      window: { maximized: true, bounds: { x: 1, y: 2, width: 3, height: 4 } },
    });
    expect(next.window.maximized).toBe(true);
    expect(next.window.bounds.width).toBe(3);
    expect(next.theme).toBe('dark'); // untouched
  });
});
