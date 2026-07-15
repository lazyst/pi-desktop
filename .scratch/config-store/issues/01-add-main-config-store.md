Status: resolved

# 主进程配置存储（config.json）

在 `src/main/index.ts` 中新增一个轻量配置模块（可内联或独立 `config.ts`）：

- 路径：`path.join(app.getPath('userData'), 'config.json')`。
- 启动时读取并解析为对象；文件不存在时用默认对象（见 spec）。
- `getConfig()` 返回当前对象；`setConfig(partial)` 做浅合并后写回（防抖 ~100ms，避免拖拽/缩放时高频写盘）。
- 读写需容错：JSON 损坏时回退默认并打印警告，不崩溃。

验收：
- 进程退出后再次启动能读到上次写入的字段。
- 损坏的 config.json 不导致启动失败。

## Comments

- 已实现并提交：\`5a757ad\`（含 docs/adr/0001、AppConfig 类型与 config:get/set IPC）。
