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
`SessionPool` 内任何“删除/终止”操作，若拿到的是磁盘 key，都必须先经 `alias` 解析出 live 进程 key，再对 live key 杀进程并 `onExit(liveKey)`，否则进程变孤儿、以 `live-<uuid>` 为 key 的终端面板关不掉。

## 外观与偏好

**主题（Theme）**：
应用外观的明暗方案，取值 `dark` | `light`。全站经一组 CSS 变量（`tokens.css`）上色，`<html>` 上的 `data-theme` 属性决定当前套用哪一组；切换主题只改变量取值、组件代码不变。
_Avoid_: 皮肤、配色方案

**设置面板（Settings Panel）**：
应用级设置的模态面板，由标题条上的设置按钮打开；当前承载主题切换、关闭行为与侧边栏宽度等，这些设置都经 IPC 读写主进程的「配置」。
_Avoid_: 偏好、选项

## 配置与窗口行为

**配置（Config）**：
主进程 `config.json`（位于 `app.getPath('userData')`）中统一存放的全部应用设置，是主题、置顶目录、窗口几何、侧边栏宽度与关闭行为的唯一真源；渲染进程经 `config:get` / `config:set` IPC 读写。
_Avoid_: 偏好、localStorage、设置

**窗口几何（Window Geometry）**：
窗口的位置与尺寸，由 `getNormalBounds()` 取到的非最大化几何加上 `maximized` 标志组成；启动时据此还原，运行中实时回写。
_Avoid_: 窗口大小、bounds

**侧边栏宽度（Sidebar Width）**：
侧边栏的可拖拽宽度，夹在 200px 地板与窗口宽 60% 上限之间，松手后持久化。
_Avoid_: 侧栏尺寸

**关闭行为（CloseBehavior）**：
标题条关闭按钮的语义，取值 `close`（真正退出应用）或 `minimize-to-tray`（最小化到托盘、pi 进程继续运行）。
_Avoid_: 退出模式、关闭方式

**托盘（Tray）**：
始终常驻系统托盘的图标，右键菜单含「显示 / 退出」，是后台运行与真正退出的入口。
_Avoid_: 通知区、系统栏

## 终端渲染

**单元度量（Cell Metrics）**：
xterm 渲染一个字符所占的像素尺寸（cellWidth / cellHeight），由字体、字号、行高与设备像素比（DPR）共同决定。会话内必须恒定，否则滚动缓冲区整屏重排时视口会上下漂移（"跳动"）。
_Avoid_: 行高、字符尺寸

**渲染器（Renderer）**：
xterm 把字符画到屏幕的后端，本应用只有 WebGL(GPU) 与内建 DOM 两档。一个会话一旦选定渲染器便不再中途切换——切换会令单元度量跳变、引发跳动。
_Avoid_: 画布后端、绘制器

**度量锁定（Metrics Lock）**：
会话 open 前用含 CJK 的等宽字体锁定字体网格，open 后只让单一渲染器以锁定单元度量渲染，禁止字体回退导致的墨迹高度漂移与渲染器切换。
_Avoid_: 字体固定、尺寸锁

**流式窗口（Streaming Window）**：
PTY 持续吐数据的时间段（用"距上次收数据 < 阈值"判定，与具体程序无关）。窗口内冻结 resize、禁止渲染器切换，以保证布局与度量稳定；窗口结束（安静）后才用锁定度量精准 refit。
_Avoid_: 输出中、刷新期
