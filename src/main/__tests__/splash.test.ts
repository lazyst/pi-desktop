// 启动动画（splash）主进程不变量测试（见 docs/adr/0003）：
//   1) 窗口以 show:false 创建（避免无边框窗口先闪白框）。
//   2) 注册 ipcMain 'splash:done' handler，收到后调用 win.show()。
//   3) splash:done 幂等：多次调用只 show 一次（dismissSplash 守卫）。
import { describe, it, expect, vi, beforeAll } from 'vitest';

const showSpy = vi.fn();
const loadFileSpy = vi.fn();
const ipcHandlers: Record<string, (...a: any[]) => void> = {};
let readyResolver: (() => void) | undefined;

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    commandLine: { appendSwitch: vi.fn() },
    whenReady: () => new Promise<void>((res) => { readyResolver = res; }),
    on: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: class {
    constructor(_opts: any) {}
    loadFile = loadFileSpy;
    loadURL = vi.fn();
    show = showSpy;
    maximize = vi.fn();
    isDestroyed = () => false;
    isVisible = () => false;
    focus = vi.fn();
    webContents = { send: vi.fn(), on: vi.fn() };
    on = vi.fn();
  },
  Tray: class { constructor() {} setToolTip() {} setContextMenu() {} on() {} },
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn(),
    on: (channel: string, cb: (...a: any[]) => void) => { ipcHandlers[channel] = cb; },
  },
}));

vi.mock('node-pty', () => ({ default: { spawn: vi.fn() } }));
vi.mock('fs', () => ({ default: { readFileSync: vi.fn(), writeFileSync: vi.fn(), existsSync: () => false, watch: vi.fn(), readdirSync: () => [] }, readFileSync: vi.fn(), writeFileSync: vi.fn(), existsSync: () => false, watch: vi.fn(), readdirSync: () => [] }));
vi.mock('./sessionPool', () => ({ SessionPool: class { constructor() {} } }));

describe('createWindow splash behavior', () => {
  beforeAll(async () => {
    await import('../index');
    readyResolver!(); // → app.whenReady().then(createWindow)
    await new Promise((r) => setTimeout(r, 20)); // 让微任务跑完，完成 createWindow
  });

  it('creates the window hidden and reveals it exactly once on splash:done', () => {
    // createWindow 未主动 show；splash:done 之前窗口保持隐藏。
    expect(loadFileSpy).toHaveBeenCalled();
    expect(showSpy).not.toHaveBeenCalled();

    // 渲染进程首屏就绪后发 splash:done → 主进程 show()。
    expect(typeof ipcHandlers['splash:done']).toBe('function');
    ipcHandlers['splash:done']();
    expect(showSpy).toHaveBeenCalledTimes(1);

    // 幂等：重复通知不应再次 show（dismissSplash 守卫，且兜底超时也不会二次 show）。
    ipcHandlers['splash:done']();
    expect(showSpy).toHaveBeenCalledTimes(1);
  });
});
