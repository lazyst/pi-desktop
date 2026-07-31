# Changelog

## [1.0.1] — 2026-07

### 修复

- **开屏动画颜色不跟随主题**：splash 的 π 图标颜色、脉冲点颜色、背景色和文字色
  始终使用 fallback 值，不随用户选择的主题变化。
  在 `</head>` 前内联脚本通过 preload 注入的初始配置同步读取 themeFamily + theme，
  设置 `--splash-bg`、`--splash-text`、`--splash-accent` 三个 CSS 变量，
  使 splash 从第一帧就使用正确的主题色

## [1.0.0] — 2026-07

### 新增

- **Mineral 主题配色改为琥珀暖橙**：从蓝绿翡翠风格全面转换为琥珀暖橙色调，
  暗色强调色 `#d97706`，浅色强调色 `#ea580c`，保留矿物/大地质感

### 修复

- **安装版终端不跟随主题切换**：`applyTheme` 缺少 `term.refresh()` 强制重绘，
  主题变更仅停留在内存中。开发模式下因 HMR 间接触发渲染故正常，
  生产构建后无额外渲染驱动导致主题变化不显示在屏幕上。
  对齐 VS Code 做法，在设置主题后添加 `term.refresh(0, rows-1)` 强制刷新视口

## [0.9.9] — 2026-07

### 新增

- **主题家族系统 — Aurora + Mineral 风格**：新增 ThemeFamily 类型 (github|aurora|mineral)，
  与 ThemeVariant (dark|light) 双属性驱动。Aurora（冷蓝渐变）和 Mineral（蓝绿翡翠）
  两套 CSS token 暗/亮色，终端 ANSI 调色板按家族分别定义，
  Monaco 编辑器 Mineral 暗色主题选中色改用蓝绿调。
  设置面板新增「配色风格」三段式选择器
- **会话查看 Markdown 渲染**：新建 SessionMarkdownRenderer 组件，
  从 MarkdownPreview 提取完整插件链（react-markdown + remark/rehype 生态），
  assistant 消息做 markdown 渲染，user/tool 消息保持纯文本。
  支持 mermaid 代码块、代码复制、右键菜单、sanitize 安全过滤
- **设置面板防抖自动保存统一**：新增 useDebouncedSave hook（800ms 防抖，
  支持深度比较、递归保存、卸载 flush），TerminalSettings / PiConfigEditor /
  PiModelConfig / PiMcpManager 统一使用，移除手动保存按钮

### 修复

- **FileTree 空目录右键菜单不显示**：roots.length === 0 时早期 return
  缺少 ContextMenu 渲染，右键菜单 state 虽设置但组件从未挂载
- **FileTree 空目录新建文件/文件夹无响应**：空目录分支未渲染
  FileTreeVirtualRows，导致 inline input 不可见
- **会话 Markdown 表格无边框**：.session-markdown-renderer 缺少
  table/th/td 样式，从 .markdown-file-preview 迁移并适配窄宽度

### 样式

- **会话视图主题配色优化**：
  - P0：用户消息气泡从整块高饱和 accent 改为半透明柔和方案
    (color-mix 12% + 1px 边框)
  - P0：AI 回复区域添加左侧 3px accent 引用线
  - P1：操作按钮使用语义色（启动→绿色，删除→红色）
  - P2：表格表头提升至 --bg-hover，新增偶数行斑马纹
- TabBar 中间区域右侧按钮默认颜色改为 var(--text)

### 变更

- **仓库重命名**：从 pi-desktop 迁移到 pi-workbench，
  更新 git remote URL、README 中英文版、updateChecker 中的仓库名和安装包文件名

## [0.9.8] — 2026-07

### 新增

- **会话内容查看页面增强**：
  - 标题行右侧添加「启动」和「删除」按钮
  - 「删除」按钮弹出确认弹窗，确认后删除会话文件并自动关闭该 tab
- **侧边栏 hover 操作按钮**：非运行中的已保存会话鼠标悬停时显示「查看」和「删除」按钮；
  「删除」使用内联确认（按钮文字变为「确认删除」），无需弹窗，右键菜单保留

### 修复

- **onIndex/onRelink 订阅在初始化后丢失**：
  `onIndex`/`onRelink` 注册在 `[initialized, setStatusMap]` 依赖的 `useEffect` 中，
  `setInitialized(true)` 导致 `initialized` 变化触发了 cleanup 注销订阅，
  重新运行时因 `if (initialized) return;` 跳过注册。这导致：
  - 删除会话后侧边栏不更新（`onIndex` 不触发）
  - 晋升后会话消失（`onRelink` 不触发）
- **会话晋升后侧边栏消失**：晋升流程中主进程先发 `onRelink`（更新 `liveToDisk`）后发 `onIndex`（更新 `disk`），
  `onIndex` 到达前会话同时在 `liveUnsaved` 和 `disk` 中缺失
- **SplitPaneDragProvider hook 数量不匹配导致黑屏**：`SplitPaneDragProvider` 在 `isActive` 变化时
  条件返回 `{children}` 早于全部 hooks，React 检测到「渲染的 hooks 比预期少」→ 黑屏。
  拆分为薄包装器 + 内层组件，条件返回在 hooks 前完成
- **侧边栏 appWorkDir 分组重复**：`appWorkDir` 同时出现在 `addedDirs` 和独立渲染路径中
- **hover inline 删除绕过确认弹窗**：`onDeleteSessionDirect` 直接调用 `pi.deleteSession` 跳过 `setConfirm` 弹窗

### 样式

- session-content 消息块之间添加视觉间距（`margin: var(--sp-5)`）

## [0.9.7] — 2026-07

### 新增

- **分屏（Split Pane）**：中间区支持分屏，每个 cwd 拥有独立的递归分屏树：
  - 分屏按钮（水平/垂直）创建新 pane，自动打开集成终端
  - 关闭 leaf 中最后一个 tab 时自动关闭该 leaf
  - 空 leaf 显示空状态（新建会话/新建终端）
  - SplitDivider 拖拽调整 pane 比例
  - 所有 cwd 分屏树同时存在于 DOM 中（keep-alive），非活跃 cwd 隐藏
- **Tab 跨 Leaf 拖拽**：支持在同 cwd 的不同 leaf 间拖拽移动 tab，
  源 leaf 的最后一个 tab 被移出时自动关闭源 leaf，
  相同 session/diff/key 的 tab 禁止拖入目标 leaf（去重保护）
- **Tab 同 Leaf 重排**：拖拽时实时插入指示线，其他 tab 移位露出空隙
- **TabBar 滚动**（VS Code 风格）：
  - 水平滚动容器，左右箭头按钮 + 渐变阴影指示边缘内容
  - 鼠标滚轮直接水平滚动（无需 Shift）
  - 自定义 2px 悬浮滚动条指示器，hover 时淡入，不占 TabBar 高度
  - 右侧按钮组（新建终端、分屏）始终固定可见
- **配置与工作目录迁移**：
  - 配置文件迁移至 `~/.pi/pi-workbench/config.json`
  - 默认工作目录改为 `~/.pi/pi-workbench/defaultWorkbench`
  - 启动时恢复上次打开的目录（`lastActiveDir`）
- **应用重命名**：从 pi-desktop 重命名为 pi-workbench

### 修复

- 分屏终端打开时事件传播竞态导致分配到错误 leaf
- SplitDivider 渲染在最后而非子 pane 之间，导致分割线不可见
- 同 leaf 拖拽因 useCallback 闭包陈旧显示红色无效状态
- 跨 leaf 拖拽时目标 leaf 其他 tab 消失（SortableContext items 管理缺失）
- 跨 leaf 拖拽时目标 leaf 其他 tab 消失（items 覆盖 defaultLeafItems）
- 点击选择工作目录导致应用全屏黑屏
- `overflow: overlay` 在 Chromium 128 中已移除，降级为 `auto`
- `scrollbar-width: thin` 与 `::-webkit-scrollbar` 冲突导致自定义无效
- 启动时未恢复上次打开的目录
- 无溢出时滚动条误显示

### 样式

- TabBar active tab 底部高亮移到顶部
- 分屏按钮组与新建终端按钮之间添加视觉分隔
- 所有 `.split-pane` 统一 `position: absolute; inset: 0` 修复黑屏

### 新增

- **MCP 配置面板全面增强**：
  - 新增所有可配置项：socket 传输、requestTimeoutMs、includeTools、trace、disabled、bearerTokenEnv、OAuth 高级配置
  - 新增文件级全局设置（toolPrefix、idleTimeout、showStatusIcon、hostConfigDiscovery、autoAuth、sampling 等）
  - 新增兼容性导入配置（cursor/claude-code/opencode 等）
  - 自动保存（防抖 500ms），移除手动保存按钮
  - 修复折叠区域双击问题（!== false → === true），默认收起
  - 服务器卡片可折叠/展开
  - 禁用/启用开关移到服务器标题栏
  - Pi 全局覆盖配置文件排到第一个
  - 设置面板记住上次打开的面板（localStorage）

### 变更

- 主题文字：暗色→深色、亮色→浅色，浅色模式 accent 改为浅蓝，切换开关滑块改为白色
- 边框/分割线统一使用 `var(--border-strong)` 提升清晰度
- 移除 `.pi-mcp-file-header` / `.pi-provider-header` 背景色

### 样式

- 调整 cwd-bar 高度为 27px、去除多余 padding
- 全局 button 重置 padding/margin，统一按钮基础样式
- cwd-select 无边框模式增加 hover 背景色

## [0.8.6] — 2026-07

### 新增

- **左右侧栏收起/展开功能**：标题栏新增侧栏/右栏收起/展开按钮，
  折叠状态持久化到 config，即时切换无过渡动画
- **TabBar 新增新建终端按钮（VS Code 风格）**：TabBar 右侧新增
  终端图标 + 下拉箭头按钮组，点击图标用默认 profile 创建终端，
  点击下拉箭头选择指定终端类型
- **空状态添加新建终端按钮**：中心区无 tab 时空状态显示新建终端按钮，
  与新建会话按钮视觉一致

### 变更

- **Pi Skills 管理重构**：使用 `npx skills ls -g --json` 获取 skill
  列表并缓存，支持按 source 字段分组折叠/展开，分类级别支持批量
  禁用/启用/删除操作。展开/收起带平滑过渡动画

### 修复

- 空状态按钮从纵向排列改为横向排列
- 修复 Git Bash 探测路径计算错误（多了一层 'Git' 目录）；
  新增从 PATH 环境变量直接搜索 bash.exe 的探测方式
- 'Command Prompt' 显示名改为 'CMD'（更常见）

## [0.8.1] — 2026-07

### 新增

- **文件树右键菜单「用系统默认程序打开」**：对所有非目录文件添加右键菜单项，
  调用系统默认程序打开文件（HTML→浏览器、PDF→阅读器、图片→看图软件等），
  由 OS 文件关联决定。

- **终端链接检测增强（移植 orca 实现）**：
  - link-provider-guard：守卫 link provider，防止 provideLinks 同步 throw 崩溃渲染器
  - linkifier-hover-reset：清除 xterm linkifier hover 缓存，使新输出立即可链接化
  - linkifier-hover-reset-on-write：流式输出后自动清除 hover 缓存，150ms throttle

- **终端链接检测替换为 orca 保守精确版**：
  - 不再自己检测 URL（交给 xterm web-links addon），避免 `abc://xxx` 等误判
  - 文件路径检测要求含路径分隔符或有扩展名，过滤纯数字/flag/无扩展名非白名单单词
  - 裸文件名白名单：`Makefile`, `Dockerfile`, `LICENSE`, `README` 等
  - 支持带空格的路径名（`/Users/me/My Project/file.ts`）
  - 移除旧 VS Code 版链接检测实现（`terminalLinks.ts`）
  - 新增 144 个测试用例覆盖全部检测逻辑

### 修复

- **终端链接跳转错误处理**：EISDIR 降级到系统文件管理器打开目录，
  ENOENT 显示友好提示「文件不存在或已被删除」，其他错误隐藏原始 IPC 错误详情
- **右键菜单改用 `data-highlighted` 替代 `:hover` 消除边框**：
  Radix UI DropdownMenu.Item 使用 data-highlighted 属性而非 CSS :hover 控制高亮，
  彻底消除 :focus-visible 浏览器默认 outline 边框

### 样式

- 移除右键菜单 hover 高亮边框，仅保留浅色背景
- 暗色主题右键菜单 hover 使用更亮的 `--bg-menu-hover: #222d3d`

## [0.8.0] — 2026-07

### 新增

- **终端渲染层重构**：从 orca 移植通用终端基础设施，拆分 XtermTerminal 单体类为 14 个独立模块
  - 输出队列调度器（output-scheduler）：前台/后台优先级队列，parse-clocked drain，backlog 上限
  - 写管道健康监控（write-pipeline-health）：10s 超时探测 + probe 写确认，防止 WriteBuffer 死锁
  - 写回调异常守卫（write-callback-guard）：防止同步 throw 冻结 xterm 写管道
  - 滚动意图跟踪（scroll-intent）：显式跟踪 followOutput / pinnedViewport 意图
  - Safe fit 滚动保持（fit）：resize 前后自动保存/恢复滚动位置
  - Reflow 弹性锚点（reflow-scroll-anchor）：列宽变化导致内容重排后视口不漂移
  - 滚动捕获/恢复（scroll）：使用 IMarker 精确跟踪视口位置，支持 deferred restore
  - WebGL 自动决策（webgl-auto-policy）：智能判断 GPU/DOM 渲染器，Linux 软件渲染器自动降级
  - 渲染暂停穿透（render-pause-release）：tab 切换后强制立即渲染
  - ACK 信用追踪（ack-credit）：防止 pane 销毁时背压信用泄漏
  - 实例销毁探针（instance-disposed）：可靠检测 xterm 实例是否已销毁
  - 滚动条同步（scrollbar-sync）：resize 后强制滚动条 thumb 同步
  - 滚动静像（scroll-buffer-snapshot）：纯函数读取 buffer 状态

### 新增

- **终端链接检测增强**：从 orca 移植链接检测基础设施
  - link-provider-guard：守卫 link provider，防止 provideLinks 中同步 throw 崩溃渲染器
  - linkifier-hover-reset：清除 xterm linkifier hover 缓存，使流式输出中的新 URL 无需鼠标移动即可被检测
  - linkifier-hover-reset-on-write：输出落地后 150ms 自动清除 hover 缓存，悬停中跳过

### 变更

- **终端链接检测替换为 orca 实现**：移除 VS Code 版过于激进的链接检测，替换为 orca 保守精确的版本
  - 不再自己检测 URL（交给 xterm web-links addon），避免 `abc://xxx` 等误判
  - 文件路径检测要求含路径分隔符或有扩展名，过滤纯数字/flag/无扩展名非白名单单词
  - 裸文件名白名单：`Makefile`, `Dockerfile`, `LICENSE`, `README` 等
  - 支持带空格的路径名（`/Users/me/My Project/file.ts`）
  - 新增 46 个链接检测测试用例

### 变更

- **XtermTerminal.ts 重构**：1833 行单体类拆分为 14 个模块 + 集成层，保持全部公开接口不变
- 移除过时的背压对齐文档（已合并到新架构）

### 技术债务

- 新增 250 个单元测试覆盖全部新模块，测试文件 13 个全部通过
- 模块化后可独立测试每个子系统，降低修改风险

## [0.7.0] — 2026-07

### 新增

- **文件树虚拟滚动重构**：用 @tanstack/react-virtual 替代递归渲染，
  拆分 FileTree 为 file-tree-types/model/Row/VirtualRows 四个模块，
  大量文件下性能显著提升
- **工作区切换改进**：主内容区目录标签改为下拉菜单，可切换到任意已
  添加的工作目录；启动时从 lastActiveDir 恢复上次选择，
  首次安装默认选 appWorkDir
- **会话内容查看**：侧边栏右键菜单新增「查看会话」，在中间区 Tab 展示
  SessionContentView 组件，按用户消息分组，区分思考过程与最终回复
  - 同一轮次内所有 thinking + tool 调用合并为一个 Process 折叠块
  - 仅保留最后一个 assistant 的最终回复，其余折叠到 Process 中
  - 加载完成后自动滚动到底部
  - 设置面板会话管理自动继承相同展示逻辑
- **工作区空状态**：无 tab 时显示居中「新建会话」按钮替代文本提示
- **Tab 计数显示优化**：移除侧边栏分组终端计数，下拉框改为自定义组件
  显示各 Session 的 tab 数量

### 变更

- **文件树 UI 组件替换**：用 lucide-react 替换自实现 SVG 图标；
  用 @radix-ui/react-context-menu 替换自实现 ContextMenu；
  用 @radix-ui/react-alert-dialog 替换自实现 ConfirmDialog
- 移除侧边栏分组终端计数徽标

### 修复

- **关闭 session tab 时终止进程**：之前关闭 session tab 仅隐藏，
  进程 keep-alive 在后台运行，现改为正常终止
- **确认弹窗被遮罩层覆盖且内容溢出**：修复 z-index 层级和内容溢出问题

---

## [0.6.0] — 2025-07

### 新增

- **Pi 启动方式改为 Orca 式 shell-ready 模式**：不再直接 spawn pi 进程，
  改为先 spawn shell，等待 shell-ready 标记（OSC 777）后自动注入 pi 命令。
  pi 退出后 shell 保留，用户可继续交互（#28）
  - 支持 zsh / bash / PowerShell / Git Bash / cmd.exe 五种 shell
  - 通过 OSC 133 D 序列检测 pi 退出，通知 UI 更新状态
- **/new 命令与侧边栏联动**：pi 内部执行 /new 命令时，侧边栏即时显示新会话条目，
  绿点指示运行状态，支持点击切换
- **Tab 访问历史**：关闭当前 active tab 时回到上一个访问的 tab，而非第一个（#29）
- **富文本编辑器 Ctrl+S 保存**：TipTap 编辑器支持 Ctrl+S 快捷键保存内容

### 变更

- **文件树右键菜单复刻 VS Code 风格**：UI 样式、行为、菜单位置完全对齐 VS Code
- 文件树目录右键「在文件管理器打开」改为打开目录自身，空白区域新增该功能
- 移除右侧栏目录选择下拉框的聚焦高亮光晕

### 修复

- **/new 后虚拟 session 未晋升**：unlinkDiskSession 未重置 entry.linked，
  导致 reconcile 跳过新 .jsonl 文件的关联
- **/new 后侧边栏残留「pi 未保存」**：onRelink 未移除虚拟 session 条目，
  虚拟 key 的 liveToDisk 映射缺失
- **detectPiExit 误触发**：OSC 133 D 只检查前缀，用户 shell VS Code shell integration
  每次 prompt 都发射该序列，导致 session 过早标记 dead
- **spawnPi 多余 TERM_PROGRAM=vscode**：触发用户 VS Code shell integration，
  加剧 detectPiExit 误触发
- 文件树右键菜单立即消失的问题

---

## [0.5.0] — 2025-07

### 新增

- **右侧栏标签平滑切换**：文件树与 Git 面板之间切换不再卸载/重建组件，
  改为双组件常驻 + CSS 显隐控制，保留展开状态、滚动位置和加载数据（#27）
- **左右滑动切换动画**：文件→Git：文件面板向左滑出、Git 从右侧滑入；
  Git→文件：反向滑动，过渡 0.18s ease
- **文件树 Git 状态联动**：文件树节点显示 Git 文件状态徽章（M/A/D），
  目录冒泡显示子项有改动，.gitignore 忽略文件以浅色显示
- **Git tab 小黄点**：工作区有未提交改动时，Git tab 上显示小黄点提示
- **侧边栏分组点击区域扩大**：整行可点击切换分组折叠状态
- **右栏默认工作目录持久化**：手动选择的工作目录在切换会话后保持
- **Git 非仓库目录优化**：快速检测 `isGitRepo` 避免非 git 目录卡死

### 变更

- **右侧栏下拉选择框美化**：
  - 宽度从 `max-width: 160px` 改为 `width: 100%`，占满右侧栏
  - 高度增加（padding: `2px 4px` → `6px 8px`）
  - 字体从等宽改为无衬线，字号加大，字重 500
  - 圆角加大，悬停变色，聚焦有光晕

---

## [0.4.3] — 2025-07

### 变更

- **版本检查不再依赖 GitHub API**：改用 `github.com/{repo}/releases/latest` 的 HTTP 302 重定向
  提取最新版本号，避免未认证请求的 60 次/小时速率限制导致的 403 错误。
  安装包下载 URL 直接按模式构造，无需 API 返回的资产列表。

---

## [0.4.2] — 2025-07

### 修复

- **终端平滑滚动设置被 wheel handler 覆盖**（#25）
  - 根因：`_initXterm` 中的 wheel handler 在每次物理滚轮事件时无条件调用
    `setSmoothScrolling(true, true)`，覆盖了用户通过设置面板配置的 `smoothScrolling: false`
  - 修复：wheel handler 先检查用户偏好 `_smoothScrolling`，仅在用户启用时
    才根据设备类型（物理滚轮/触控板）调整 `smoothScrollDuration`

---

## [0.4.1] — 2025-07

### 修复

- **更新安装程序无法启动**：Windows 上点击「立即安装」后应用退出但安装程序无反应（#24）
  - 根因：`execFile` + `detached` 模式下 Windows GUI 安装程序无法正确显示窗口
  - 修复：改用 `spawn('cmd.exe', ['/c', 'start', ...])` 启动安装程序，这是 Windows 启动 GUI 应用的标准方式
  - 渲染层 `handleInstall` 的错误处理从静默吞异常改为显示错误信息

---

## [0.4.0] — 2025-07

### 新增

- **双实例支持**：开发版可通过 `PI_DESKTOP_DEV=1` 环境变量启动，与安装版使用不同的
  app.name、config 文件和托盘标识，两者可同时运行（#23）
  - 开发版使用 `pi-desktop-dev` 作为 app.name（单实例锁隔离）
  - 配置独立存储于 `~/pi-desktop/config-dev.json`
  - 托盘 tooltip 显示 `pi-desktop [DEV]` 便于区分
  - 关闭按钮直接退出应用（不最小化到托盘）
  - 窗口标题添加 `[DEV]` 后缀

### 变更

- **图标重新设计**：tray icon 从紫色(`#7c3aed`)背景 + 白色 π 符号
  改为浅米色(`#ebe7e4`)背景 + 深色(`#09090b`) π 符号
  - 更新 PNG 和 ICO（含 16/32/48/64/128/256 六种尺寸）

---

## [0.3.0] — 2025-07

### 新增

- **终端设置面板新增 12 项可配置项**（按类别分组）：
  - **光标**：cursorBlink（闪烁开关）、cursorStyle（block/bar/underline）、cursorInactiveStyle（非活跃样式）、cursorWidth（1-25px）
  - **字体**：fontFamily（文本输入 + 8 种常用等宽字体预设）、lineHeight（0.5-3.0）、letterSpacing（-5~20px）、fontWeight / fontWeightBold（9 级字重）
  - **滚动**：smoothScrolling（平滑滚动开关）、scrollSensitivity（0.1-20）、fastScrollSensitivity（1-100）
  - **滚动条**：scrollbarWidth（6-40px）
  - 所有配置项修改后即时生效到所有存活终端，新建终端自动读取持久化值

### 修复

- 设置面板终端页内容区无法滚动（`overflow:hidden` → `overflow-y:auto`）
- 数字输入框布局居中问题（输入框+单位包裹为 `input-unit-group`，靠右对齐）

---

## [0.2.1] — 2025-07

## [0.2.0] — 2025-07

### 新增

- **终端背压流控全面对齐 VS Code**：
  - 背压计数时点从 5ms 聚合窗口移至 PTY 源头实时计数
  - IPC ack 累积（`AckDataBufferer`，`CharCountAckSize=5000`），减少高频 IPC 通信量
  - 同步写模式（`writeSync`），高优先级消息不受背压阻塞
- **目录分组折叠**：左侧栏目录分组可折叠，折叠状态持久化到 config
- **会话内容查看**：会话管理面板支持查看 Pi 会话完整内容
- **Pi 工具配置管理**：集成到设置面板

### 修复

- 目录分组操作按钮改为绝对定位，不占用标题行空间
- `_writeProcessDataUnsafe` 对齐 VS Code 发送 ack，背压水位准确

---

## [0.1.1] — 2025-07

### 新增

- **终端深度对齐 VS Code 集成终端**：
  - 命令检测（CommandDetectionCapability，OSC 633 序列）
  - CWD 检测（CwdDetectionCapability）
  - 链接检测与打开（OSC 8 超链接、文件路径、编辑器打开）
  - 查找（SearchAddon）
  - 缓冲区持久化
  - 滚动稳定与 scrollback 可配置
  - 标记导航（MarkNavigationAddon）
- **设置面板**：常规（主题、关闭行为、字号）、会话管理、终端配置

### 修复

- 终端链接交互：修饰键激活、hover 装饰、文件协议处理
- 安全对话框绕过：改用 `child_process.exec` 打开外部 URL
- 多次 revert 后重新稳定链接交互

---

## [0.1.0] — 2025-06

### 新增

- **集成终端（VS Code 式）**：
  - XtermTerminal 薄封装，对齐 VS Code 装配（WebGL 渲染、FitAddon、SearchAddon、ClipboardAddon）
  - 按工作目录分组 + 计数徽标
  - 应用工作目录分组（收容无关会话）
  - 外部拖入文件转绝对路径粘贴
  - 右键复制/粘贴
  - 置底按钮（Jump-to-bottom FAB）
  - 平滑滚动
- **编辑器**：
  - Monaco 编辑器集成（Markdown 渲染预览 + 源码编辑 + TipTap 富文本）
  - MonacoDiffEditor 单栏 diff 视图
  - 文件预览（文本/图片/Markdown）
  - 字号跟随全局字体缩放
  - Ctrl+S 保存
- **文件管理器**：
  - 文件树（新建/重命名/删除/移动/复制粘贴/多选）
  - 拖拽到终端粘贴为路径
  - 外部变更自动刷新（FileWatcher）
  - 文件面板宽度可拖拽调整（持久化到 config）
- **Git 工作区**：事件驱动实时刷新、右栏单栏 diff
- **侧边栏**：
  - 按目录分组展示会话
  - 会话状态指示（运行中/已退出）
  - 终止进程、切换会话
  - 拖拽重排（@dnd-kit）
  - 宽度可拖拽调整（持久化到 config）
- **Tab 系统**：
  - 多类型 Tab 混排（session/preview/diff）
  - 按工作目录自动分组（TabAutoGroup）
  - 拖拽重排
- **设置面板**：主题（暗/亮）、关闭行为（关闭/最小化到托盘）、全局字号、终端配置
- **系统托盘**：常驻托盘，关闭按钮可配置为最小化到托盘
- **窗口管理**：单实例锁、窗口位置记忆、无边框+自建标题条
- **启动动画**（splash screen）
- **Pi 工具集成**：模型配置、MCP 管理、Skills 管理、扩展管理（设置面板中）

### 修复

- 终端流式输出闪烁（对齐 VS Code 渲染管线）
- 终端新建后黑屏（IPC 载荷格式不匹配、config.ts 沙箱崩溃）
- 终端退出后 resize 崩溃
- 终端 tab 重复/切换失效
- 终端链接安全对话框
- 文件树根目录异步到达后永久为空
- 预览 tab 未保存改动静默丢弃
- 侧边栏目录/会话/终止进程状态
- 主进程 `config.ts` 的 `node:os/path` 导入导致 renderer 沙箱崩溃
- 无边框窗口白屏闪屏
- 全屏下外壳多余滚动条

### 重构

- 终端完全采用 VS Code 集成终端同款组件与装配
- 终端渲染抽为 XtermTerminal 薄封装
- 终端主题/字号刷新抽为单点订阅（terminal-registry）
- 三栏布局（侧边栏 / 文件面板 / 主内容区）
- 通用 Tab 框架（中间区统一混排 session/preview/diff）
- 状态管理迁移至 zustand（tabStore）
- 主进程 config.json 作为设置唯一真源（ADR-0001）
- 移除 CodeMirror 依赖，完成 Monaco 接管
- 移除 PDF 预览、二进制交系统打开

### 文档

- README 中英文版
- ADR 架构决策记录
- 实现计划与设计规格文档
- Agent 工作流文档（issue-tracker / triage / domain）

---

## [0.0.1] — 2025-06

### 新增

- 项目脚手架：Electron + React + Vite（electron-vite）
- IPC 桥接层（preload + main handler）
- SessionPool：PTY 进程管理（spawn/kill/status/list）
- 基础侧边栏 + 终端面板组合
- Playwright E2E 测试框架（fake backend）
- 设计令牌（tokens.css）与 UI 组件样式
- JetBrains Mono 字体嵌入