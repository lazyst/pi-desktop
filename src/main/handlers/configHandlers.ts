import type { AppConfig } from '../../renderer/src/types';

/**
 * 配置与窗口控制相关 IPC handler 注册。
 *
 * 包含 config:* 和 window:* 系列 handler。
 */
export function registerConfigHandlers(
  ipcMain: Electron.IpcMain,
  win: Electron.BrowserWindow,
  getConfig: () => AppConfig,
  setConfig: (partial: Partial<AppConfig>) => void,
): void {
  // 配置存储：渲染进程经 IPC 读写主进程 config.json（唯一真源，见 docs/adr/0001）。
  ipcMain.handle('config:get', () => getConfig());
  ipcMain.handle('config:set', (_e, partial: Partial<AppConfig>) => {
    setConfig(partial);
    // 主题切换时同步窗口合成背景色，使最小化/托盘恢复（hide→show）不再闪亮
    // （backgroundColor 与 --bg-app / theme.ts 静态色同源）。
    if (partial.theme && (partial.theme === 'light' || partial.theme === 'dark')) {
      if (!win.isDestroyed()) win.setBackgroundColor(partial.theme === 'light' ? '#ffffff' : '#0d1117');
    }
    if (!win.isDestroyed()) win.webContents.send('config:change', getConfig());
  });

  // 无边框窗口的窗口控制（自建标题条调用）
  ipcMain.on('window:minimize', () => { if (!win.isDestroyed()) win.minimize(); });
  ipcMain.on('window:toggle-maximize', () => {
    if (win.isDestroyed()) return;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  });
  ipcMain.on('window:close', () => { if (!win.isDestroyed()) win.close(); });
  ipcMain.handle('window:get-bounds', () => win.getBounds());
  ipcMain.on('window:set-bounds', (_e, b: { x: number; y: number; width: number; height: number }) => {
    if (!win.isDestroyed()) win.setBounds(b);
  });
  win.on('maximize', () => { if (!win.isDestroyed()) win.webContents.send('window:maximize-change', true); });
  win.on('unmaximize', () => { if (!win.isDestroyed()) win.webContents.send('window:maximize-change', false); });
  // 任务栏最小化→点任务栏图标恢复（OS 原生 restore，绕过 showWindow 的透明桥接）
  // 同样会触发 DWM 白首帧，故在 restore 瞬间用 opacity 0→1 桥接吃掉白闪。
  // 仅当窗口确实刚从隐藏恢复时才桥接（isVisible 在 restore 事件触发时已为 true，
  // 故用 'restore' 事件本身即代表发生了隐藏→显示，直接桥接一次即可）。
  win.on('restore', () => {
    if (win.isDestroyed()) return;
    win.setOpacity(0);
    setTimeout(() => {
      if (!win.isDestroyed()) win.setOpacity(1);
    }, 20);
  });
}