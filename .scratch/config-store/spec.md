# 配置存储（主进程 config.json）

把 pi-desktop 的全部应用设置统一收进主进程的 `config.json`（位于 `app.getPath('userData')`），主进程为唯一真源；渲染进程的设置面板通过新增的 `config:get` / `config:set` IPC 读写，不再使用渲染进程的 `localStorage`。

来源：设计记录于 `docs/adr/0001-main-process-config-store.md`（决策①）。

## 配置形态（节选）

```jsonc
{
  "theme": "dark",
  "pinnedDirs": ["…"],
  "window": { "maximized": false, "bounds": { "x":…, "y":…, "w":…, "h":… } },
  "sidebarWidth": 280,
  "closeBehavior": "minimize-to-tray"
}
```

## 范围
- 主进程：加载/写入 `config.json`，提供合并式 `getConfig()` / `setConfig(partial)`（防抖写盘）。
- IPC：`config:get`（invoke）/`config:set`（invoke，合并 + 持久化 + 广播 `config:change`）。
- 迁移：主题、置顶目录从 `localStorage` 迁到 `config`（经 IPC 读写）。

## 不变量
- 主进程是唯一真源；渲染进程可乐观本地应用（如主题换色）再经 IPC 持久化。
- 窗口级字段（`window`、`sidebarWidth`、`closeBehavior`）必须在主进程可读——窗口创建前与点击关闭时。
