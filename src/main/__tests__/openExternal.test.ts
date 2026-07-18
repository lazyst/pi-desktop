// 受控外部链接通道（app:openExternal）主进程白名单测试（见 grilling 会话结论）。
// 主进程集中校验协议白名单：仅放行 http(s) 与 mailto:，其余（file://、javascript:、
// 相对/非法 URL）一律拒绝；放行项才调用 shell.openExternal。
import { describe, it, expect, vi, beforeAll } from 'vitest';

const openExternalSpy = vi.fn().mockResolvedValue(undefined);
const ipcHandlers: Record<string, (...a: any[]) => any> = {};
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
    loadFile = vi.fn();
    loadURL = vi.fn();
    show = vi.fn();
    maximize = vi.fn();
    isDestroyed = () => false;
    isVisible = () => false;
    focus = vi.fn();
    webContents = { send: vi.fn(), on: vi.fn(), setWindowOpenHandler: vi.fn() };
    on = vi.fn();
  },
  Tray: class { constructor() {} setToolTip() {} setContextMenu() {} on() {} },
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openExternal: openExternalSpy },
  ipcMain: {
    handle: (channel: string, cb: (...a: any[]) => any) => { ipcHandlers[channel] = cb; },
    on: vi.fn(),
  },
}));

vi.mock('node-pty', () => ({ default: { spawn: vi.fn() } }));
vi.mock('fs', () => ({ default: { readFileSync: vi.fn(), writeFileSync: vi.fn(), existsSync: () => false, watch: vi.fn(), readdirSync: () => [] }, readFileSync: vi.fn(), writeFileSync: vi.fn(), existsSync: () => false, watch: vi.fn(), readdirSync: () => [] }));
vi.mock('./sessionPool', () => ({ SessionPool: class { constructor() {} } }));

describe('app:openExternal whitelist', () => {
  beforeAll(async () => {
    await import('../index');
    readyResolver!(); // → app.whenReady().then(createWindow)
    await new Promise((r) => setTimeout(r, 20)); // 让微任务跑完，完成 createWindow
  });

  it('放行 https URL 并调用 shell.openExternal', async () => {
    expect(typeof ipcHandlers['app:openExternal']).toBe('function');
    openExternalSpy.mockClear();
    const ok = await ipcHandlers['app:openExternal'](null, 'https://example.com/doc');
    expect(ok).toBe(true);
    expect(openExternalSpy).toHaveBeenCalledWith('https://example.com/doc');
  });

  it('放行 http URL', async () => {
    openExternalSpy.mockClear();
    const ok = await ipcHandlers['app:openExternal'](null, 'http://example.com');
    expect(ok).toBe(true);
    expect(openExternalSpy).toHaveBeenCalledTimes(1);
  });

  it('放行 mailto: 协议', async () => {
    openExternalSpy.mockClear();
    const ok = await ipcHandlers['app:openExternal'](null, 'mailto:dev@example.com');
    expect(ok).toBe(true);
    expect(openExternalSpy).toHaveBeenCalledTimes(1);
  });

  it('拒绝 file:// —— 该协议不走通用通道（由 PdfPreview webview 隔离处理）', async () => {
    openExternalSpy.mockClear();
    const ok = await ipcHandlers['app:openExternal'](null, 'file:///etc/passwd');
    expect(ok).toBe(false);
    expect(openExternalSpy).not.toHaveBeenCalled();
  });

  it('拒绝 javascript: 等危险协议', async () => {
    openExternalSpy.mockClear();
    const ok = await ipcHandlers['app:openExternal'](null, 'javascript:alert(1)');
    expect(ok).toBe(false);
    expect(openExternalSpy).not.toHaveBeenCalled();
  });

  it('拒绝非法/相对 URL（URL 解析失败）', async () => {
    openExternalSpy.mockClear();
    const ok = await ipcHandlers['app:openExternal'](null, 'not a url');
    expect(ok).toBe(false);
    expect(openExternalSpy).not.toHaveBeenCalled();
  });

  it('拒绝空/非字符串入参', async () => {
    openExternalSpy.mockClear();
    expect(await ipcHandlers['app:openExternal'](null, '')).toBe(false);
    expect(await ipcHandlers['app:openExternal'](null, undefined)).toBe(false);
    expect(openExternalSpy).not.toHaveBeenCalled();
  });
});
