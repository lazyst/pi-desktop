import { describe, it, expect } from 'vitest';
import { snapshotWindowState, initialBoundsOptions } from '../windowState';

describe('snapshotWindowState', () => {
  it('captures the maximized flag together with the normal (restored) bounds', () => {
    const win = {
      isMaximized: () => true,
      getNormalBounds: () => ({ x: 10, y: 20, width: 800, height: 600 }),
    };
    expect(snapshotWindowState(win)).toEqual({
      maximized: true,
      bounds: { x: 10, y: 20, width: 800, height: 600 },
    });
  });

  it('captures an unmaximized flag', () => {
    const win = {
      isMaximized: () => false,
      getNormalBounds: () => ({ x: 1, y: 2, width: 3, height: 4 }),
    };
    expect(snapshotWindowState(win).maximized).toBe(false);
    expect(snapshotWindowState(win).bounds).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });
});

describe('initialBoundsOptions', () => {
  it('omits x/y at the default {0,0} so Electron centers the window', () => {
    expect(initialBoundsOptions({ x: 0, y: 0, width: 1100, height: 720 })).toEqual({
      width: 1100,
      height: 720,
    });
  });

  it('includes x/y once a real position has been stored', () => {
    expect(initialBoundsOptions({ x: 120, y: 60, width: 900, height: 650 })).toEqual({
      x: 120,
      y: 60,
      width: 900,
      height: 650,
    });
  });
});
