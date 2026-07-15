import type { WindowState, Bounds } from '../renderer/src/types';

// Read the persistable window state from a live BrowserWindow.
// `getNormalBounds()` returns the NON-maximized geometry, so we always store the
// "restored" size/position and keep `maximized` as a separate boolean — on
// relaunch we restore the bounds, then call maximize() if the flag is set
// (see docs/adr/0001 决策②). Passing a minimal shape keeps this pure + testable.
export function snapshotWindowState(
  win: { isMaximized(): boolean; getNormalBounds(): Bounds },
): WindowState {
  return { maximized: win.isMaximized(), bounds: win.getNormalBounds() };
}

// Build the initial BrowserWindow geometry options from persisted state.
// If the stored position is the default {0,0} (i.e. the window has never been
// explicitly placed) we OMIT x/y so Electron centers it — matching the old
// behaviour where no x/y were passed. Once the user moves it, a real position is
// saved and used on the next launch.
export function initialBoundsOptions(b: Bounds): {
  width: number;
  height: number;
  x?: number;
  y?: number;
} {
  const opts: { width: number; height: number; x?: number; y?: number } = {
    width: b.width,
    height: b.height,
  };
  if (b.x !== 0 || b.y !== 0) {
    opts.x = b.x;
    opts.y = b.y;
  }
  return opts;
}
