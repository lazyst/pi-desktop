import * as fs from 'node:fs';
import { ReferenceCountedWatcher } from '../shared/ReferenceCountedWatcher';
import { gitStatus, gitLog, gitDiff, gitFileStatusMap, gitIgnoredPaths } from '../gitBridge';

/**
 * Git 相关 IPC handler 注册。
 *
 * 包含 git:* 系列 handler 以及工作区实时监听。
 */
export function registerGitHandlers(
  ipcMain: Electron.IpcMain,
  win: Electron.BrowserWindow,
): void {
  // ── Git 只读查看 ──
  const gitCooldownUntil = new Map<string, number>();

  ipcMain.handle('git:status', async (_e, req: { cwd: string }) => {
    gitCooldownUntil.set(req.cwd, Date.now() + 2000);
    try {
      return await gitStatus(req.cwd);
    } finally {
      // 命令完成后保持冷却，避免 Windows fs.watch 延迟事件触发循环
    }
  });
  ipcMain.handle('git:log', (_e, req: { cwd: string; limit?: number }) => gitLog(req.cwd, req.limit));
  ipcMain.handle('git:diff', (_e, req: { cwd: string; ref?: string }) => gitDiff(req.cwd, req.ref));
  ipcMain.handle('git:fileStatusMap', async (_e, req: { cwd: string }) => {
    gitCooldownUntil.set(req.cwd, Date.now() + 2000);
    try {
      return await gitFileStatusMap(req.cwd);
    } finally {
      // 命令完成后保持冷却
    }
  });
  // 获取被 .gitignore 忽略的顶层路径集合
  ipcMain.handle('git:ignoredPaths', async (_e, req: { cwd: string }) => {
    return await gitIgnoredPaths(req.cwd);
  });

  // ── Git 工作区实时监听（事件驱动刷新）──
  // 渲染端订阅某仓库 cwd，主进程以 recursive 监听整个仓库目录，任意变更即经 'git:change' 推送。
  // 同一 cwd 可能被多处订阅，用引用计数管理，最后一处取消才真正关闭底层 watcher。
  //
  // ⚠️ 无限循环防护：用时间戳冷却代替简单的 Set，避免 Windows fs.watch 延迟事件造成的循环。
  //    git 命令执行后 2000ms 内的 fs.watch 事件均视为自触发，不发送 git:change。
  const gitWatchers = new ReferenceCountedWatcher<string>();
  ipcMain.on('git:watch', (_e, req: { cwd: string }) => {
    const cwd = req.cwd;
    gitWatchers.watch(cwd, (key) => {
      let watcher: fs.FSWatcher | undefined;
      let closed = false;
      const stop = () => {
        if (closed) return;
        closed = true;
        try { watcher?.close(); } catch { /* 已关闭，忽略 */ }
      };
      try {
        watcher = fs.watch(key, { recursive: true }, () => {
          // 跳过 git 命令自身触发的 .git/ 变更，避免无限循环
          if (Date.now() < (gitCooldownUntil.get(key) ?? 0)) return;
          if (!win.isDestroyed()) win.webContents.send('git:change', { cwd: key });
        });
        watcher.on('error', () => stop());
      } catch {
        // 目录不存在/无权限：降级为 no-op
        return () => {}; // 空 stop，不触发任何操作
      }
      return stop;
    });
  });
  ipcMain.on('git:unwatch', (_e, req: { cwd: string }) => {
    gitWatchers.unwatch(req.cwd);
  });
}