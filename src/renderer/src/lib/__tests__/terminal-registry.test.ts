// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// 主题/字号切换会经 pi.setConfig 持久化，但测试环境无 IPC，需打桩。
vi.mock('../../ipc', () => ({
  pi: { setConfig: vi.fn().mockResolvedValue(undefined) },
}));

import {
  registerTerminal,
  unregisterTerminal,
  liveTerminalCount,
  type LiveTerminal,
} from '../terminal-registry';
import { setTheme, getTheme } from '../../theme';
import { setFontSize, getFontSize } from '../../fontSize';

// 测试用存活终端桩：记录最近一次 applyTheme / applyFontSize 入参。
function makeFakeTerminal(): LiveTerminal & { theme: string | null; size: number | null } {
  return {
    theme: null,
    size: null,
    applyTheme(t) {
      this.theme = t;
    },
    applyFontSize(s) {
      this.size = s;
    },
  };
}

describe('terminal-registry 单点订阅刷新所有存活实例', () => {
  beforeEach(() => {
    // 起始环境复位，避免跨测试串扰。
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.style.setProperty('--font-scale', String(13 / 13));
  });

  it('register/unregister 维护存活集合', () => {
    const a = makeFakeTerminal();
    const b = makeFakeTerminal();
    expect(liveTerminalCount()).toBe(0);
    registerTerminal(a);
    registerTerminal(b);
    expect(liveTerminalCount()).toBe(2);
    unregisterTerminal(a);
    expect(liveTerminalCount()).toBe(1);
    unregisterTerminal(b);
    expect(liveTerminalCount()).toBe(0);
  });

  it('主题切换经 onThemeChange 统一刷新所有存活实例', () => {
    const a = makeFakeTerminal();
    const b = makeFakeTerminal();
    registerTerminal(a);
    registerTerminal(b);
    // 初始主题（mount 时）不应被 registry 直接驱动，需在 setTheme 时才刷新。
    a.theme = null;
    b.theme = null;

    setTheme('light');
    expect(getTheme()).toBe('light');
    expect(a.theme).toBe('light');
    expect(b.theme).toBe('light');

    setTheme('dark');
    expect(a.theme).toBe('dark');
    expect(b.theme).toBe('dark');

    unregisterTerminal(a);
    unregisterTerminal(b);
  });

  it('字号变化经 onFontSizeChange 统一刷新所有存活实例', () => {
    const a = makeFakeTerminal();
    const b = makeFakeTerminal();
    registerTerminal(a);
    registerTerminal(b);
    a.size = null;
    b.size = null;

    const next = setFontSize(18);
    expect(getFontSize()).toBe(18);
    expect(a.size).toBe(18);
    expect(b.size).toBe(18);
    expect(next).toBe(18);

    unregisterTerminal(a);
    unregisterTerminal(b);
  });

  it('已注销的实例不再被刷新', () => {
    const a = makeFakeTerminal();
    registerTerminal(a);
    unregisterTerminal(a);
    a.theme = null;
    setTheme('light');
    expect(a.theme).toBe(null);
  });
});
