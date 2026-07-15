Status: ready-for-agent

# 暴露 config:get / config:set IPC

- 主进程 `ipcMain`：`config:get`（handle，返回 `getConfig()`）、`config:set`（handle，入参 `partial`，调用 `setConfig(partial)` 并广播 `config:change` 给视图）。
- 预加载 `src/preload/index.ts`：在 `contextBridge.exposeInMainWorld('pi', …)` 中补充 `getConfig: () => ipcRenderer.invoke('config:get')`、`setConfig: (partial) => ipcRenderer.invoke('config:set', partial)`。
- 渲染 `src/renderer/src/ipc.ts` 的 `PiApi` 接口补 `getConfig()` / `setConfig(partial: Partial<AppConfig>)`；导出 `AppConfig` 类型（theme / pinnedDirs / window / sidebarWidth / closeBehavior 的形状）。

验收：
- 渲染进程能 `getConfig()` 拿到全量配置、`setConfig({…})` 后主进程落盘并收到 `config:change`。

注意：`AppConfig` 类型定义在渲染端 `types.ts` 或独立 `config.ts`，主进程与预加载共用同一形状。
