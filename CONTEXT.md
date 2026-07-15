# pi-desktop 领域模型

桌面应用：把 `pi` CLI 的真实 TUI 封装进多个相互隔离的终端，并用侧边栏会话列表管理。本文只记录本项目特有的领域词汇，不涉及通用编程概念。

## 会话与目录

**会话（Session）**：
一次 `pi` 交互过程。磁盘上对应 `sessionsDir` 下的一个 `.jsonl` 文件；运行时还对应一个 `node-pty` 进程。会话有两套标识：运行期以 `live-<uuid>` 为 key 活在 `SessionPool`，写盘后通过 `alias` 关联到其 `.jsonl` 绝对路径（磁盘 key）。
_Avoid_: 终端、标签、连接

**目录 / cwd 工作组（Group）**：
按工作目录（`cwd`）分组的会话集合，是侧边栏里的一个折叠分组。磁盘上对应 `sessionsDir/<编码cwd>/` 文件夹。一个 cwd 下的所有 `.jsonl` 都属于同一组。
_Avoid_: 文件夹、项目、分类

**晋升（Promotion）**：
在本应用内新建的会话（`live-<uuid>`）在用户发出首条消息、`pi` 写出 `.jsonl` 后，从"仅活在终端区"变为"出现在侧边栏"的过程。晋升后磁盘 key 通过 `alias` 反向关联到仍运行中的 live 进程，点击侧边栏条目会复用同一进程而非新开。
_Avoid_: 同步、挂载

**清空目录（Clear Directory）**：
一次性终止某 cwd 工作组内所有运行中的进程，并删除该组对应的全部 `.jsonl` 文件（整组从侧边栏消失）。等价于"选中该组全部会话并删除"。
_Avoid_: 关闭目录、重置目录

**批量删除（Batch Delete）**：
用户在多选模式下跨目录任意勾选若干会话后，一次性终止其运行进程并删除对应 `.jsonl` 文件。

**多选模式（Selection Mode）**：
侧边栏的一种临时状态：每条会话显示 checkbox，点击会话切换勾选而非打开终端面板；顶部出现"已选 N 项 · 删除 · 取消"操作栏。退出后恢复常态。

## 进程生命周期

**终止（Terminate）**：
仅杀掉会话的 `node-pty` 进程，保留 `.jsonl` 文件（侧边栏条目仍在，状态变"空闲"）。对应 `SessionPool.terminate`。
_Avoid_: 删除、关闭

**删除（Delete）**：
终止进程并删除其 `.jsonl` 文件（`terminate` + 文件删除）。对应 `SessionPool.deleteSession` / `deleteMany` / `clearDirectory`。
_Avoid_: 清空（清空是"删除整组"的特例）

## 关键不变量

**磁盘 key 必须反查 live key**：
`SessionPool` 内任何"删除/终止"操作，若拿到的是磁盘 key，都必须先经 `alias` 解析出 live 进程 key，再对 live key 杀进程并 `onExit(liveKey)`，否则进程变孤儿、以 `live-<uuid>` 为 key 的终端面板关不掉。
