# 集成终端按工作目录分组 + 计数徽标 + 应用工作目录分组

> 状态：方案已通过 grilling 评审（2025-xx-xx）
> 范围：左侧会话分组侧边栏新增"集成终端计数徽标"，并新增"应用工作目录分组"用于收容与具体项目无关的临时/闲聊终端。

## 1. 背景与问题

用户期望：集成终端跟随当前 pi 会话的工作目录进行组织与显示。

原始现象描述（用户原话）："在一个工作目录启动 pi 会话 → 新建集成终端；再启动另一个工作目录的 pi 会话 → 再新建集成终端；两个不同工作目录中启动的集成终端都会显示在同一个集成终端面板中。希望按当前 pi 会话的工作目录显示，左侧目录分组显示当前目录下启动了几个集成终端。"

经 grill 澄清，实际架构与诉求如下：

- **架构事实**：每个 pi 会话是独立 Electron 窗口，每窗口的 `TerminalDrawer` 只渲染本窗口 store 里的 tab；`IntegratedTerminalPool` 是主进程单例，但终端列表不下发到其它窗口。因此**不存在"跨窗口终端串台"**——用户最初描述的"B 跨窗口混在一起"是单窗口内切换会话的误解（已确认为场景 A：同一窗口内切换会话 tab）。
- **真实诉求**：在左侧已有的会话分组（按 `cwd` 聚合的 `SessionGroup`）标题后，显示该目录下"正在运行的集成终端数"，形如 `(3 Terminal)`；并新增一个"应用工作目录分组"，用于收容没有具体项目、与 pi-agent 闲聊或临时用的集成终端。

## 2. 已确认的结论（grilling 结论）

| # | 问题 | 结论 |
|---|------|------|
| Q1 | 两个工作目录是两个独立窗口，还是单窗口切换？ | **单窗口切换（场景 A）**，无跨窗口串台，无需做终端隔离。 |
| Q2 | 集成终端按哪个 cwd 归属分组？ | **创建时按"当前聚焦会话的 cwd"归属，永久归属该 cwd 分组**（按终端自身 `IntegratedTerminalInfo.cwd` 聚合，不因后续切换会话而跳组）。 |
| Q3 | 没有 pi 会话、但跑了集成终端的目录怎么显示？ | 不挂到具体项目目录，改挂到新增的**"应用工作目录分组"**。 |
| Q4 | 左侧 UI 形态？ | 不新建 UI，仅在目录标题后追加括号计数 `(N Terminal)`。 |
| Q5 | "应用工作目录分组"的 cwd 来源？ | 应用使用一个**默认创建**的目录，默认 `path.join(os.homedir(), 'piDesktop')`，可在设置面板改成其他目录。 |
| Q6 | 用户如何把终端开进"应用工作目录分组"？ | 在"应用工作目录分组"这一项上**单独放一个 `+`**，点它就在应用工作目录 cwd 开终端（方案 i）。 |
| Q7 | 括号 `N` 的计数口径？ | **纯集成终端计数**（不含 pi 会话数）。 |

## 3. 待确认假设（grilling 末轮未明确回复，按推荐默认值落定，实现前需用户拍板）

> 这三项是 grill 最后一问中用户未逐条回复的部分。文档按"我赌"的推荐方向落定，标注为假设，进入实现前需用户确认。

- **A1 默认值落地方式**：主进程 `loadConfig` 发现 `appWorkDir` 缺失时，自动填 `path.join(os.homedir(), 'piDesktop')` 并**写回持久化**（而非仅渲染层临时兜底）。→ 推荐 (a)。
- **A2 目录自动创建**：主进程在确保 `appWorkDir` 存在后再传给 `create()`（若目录不存在，`integratedTerminalPool.ts:51` 的 `safeCwd` 会静默回退到 `process.cwd()`，导致分组语义失效）。→ 推荐**主进程 `fs.mkdirSync(appWorkDir, { recursive: true })`**。
- **A3 设置面板 UI**：`TerminalSettings` 中新增 `appWorkDir` 字段，采用**文本框 + 「浏览…」按钮**（`dialog.showOpenDialog` 选目录）；**修改目录不迁移**已有终端（只影响之后新建的），旧终端留在原 cwd 分组自然消亡。→ 推荐 (a) + 不迁移。

## 4. 目标数据/UI 模型

```
左侧分组联合列表 =
  [ 项目 SessionGroup(cwd)      → 标题 + (N_terminal) ]   // N = 该 cwd 下运行中的集成终端数
  [ "应用工作目录" 分组(appWorkDir) → 标题 + (N_terminal) ] // N = 归属 appWorkDir 的集成终端数；该项自带 + 入口
```

- 终端归属判定（渲染层聚合时）：
  - 终端 `info.cwd === appWorkDir` → 归入"应用工作目录分组"。
  - 终端 `info.cwd` 命中某个 `SessionGroup.cwd` → 归入该项目分组。
  - 终端 `info.cwd` 既不等于 `appWorkDir`、也不命中任何 `SessionGroup.cwd`（例如历史遗留 / 已改 appWorkDir 前的旧终端）→ 仍按自身 cwd 计入对应项目分组（若该 cwd 当前无 SessionGroup 则不显示分组，仅计数累加进"应用工作目录分组"的兜底计数**或**单独作为无分组计数；见 §5 边界处理）。

## 5. 边界处理

1. **终端退出**：`IntegratedTerminalPool` 的 `onExit` 回调已存在（`integratedTerminalPool.ts:86`），需确保渲染层据此刷新计数（见 §6 IPC）。
2. **appWorkDir 与某项目 cwd 撞车**：若用户把 `appWorkDir` 配置成某个已有 pi 会话的目录，则该目录既是项目分组、又等于 appWorkDir。判定优先级：**先匹配 `appWorkDir`**（归"应用工作目录分组"），避免双重计数。
3. **改 appWorkDir 后旧终端**：按 A3 不迁移；旧终端 `info.cwd` 仍是旧值，按 §4 规则归到旧 cwd 对应分组（若无 SessionGroup 则归入兜底计数）。

## 6. 改动清单

| 文件 | 改动 |
|------|------|
| `src/renderer/src/types.ts` | `AppConfig` 新增 `appWorkDir: string`；`IntegratedTerminalInfo` 已有 `cwd` 字段，无需改。 |
| `src/main/index.ts`（主进程） | `loadConfig` 补默认 `appWorkDir`（A1）；启动/读配置时 `fs.mkdirSync(appWorkDir,{recursive:true})`（A2）；新增 IPC `listIntegratedTerminals()` 返回 `IntegratedTerminalInfo[]`（由 `pool.entries` map 出 `info`）；`createTerminal` 入口支持传入 `appWorkDir` 作为 cwd；终端列表变化事件（create/destroy/exit 时主动推送渲染层，避免轮询）。 |
| `src/main/integratedTerminalPool.ts` | 基本不动；`create(profile, cwd)` 已接受 cwd；确保传入的 `appWorkDir` 已由上层建好（或在此处对 `appWorkDir` 做 exists 兜底建目录）。 |
| `src/preload/index.ts` + `src/renderer/src/ipc.ts` | 暴露 `listIntegratedTerminals()`、`createTerminalInAppWorkDir()`（或通用 `createTerminal(cwd)`）、以及终端列表变化订阅（如 `onIntegratedTerminalsChanged(cb)`）。 |
| `src/renderer/src/App.tsx` | 订阅终端列表变化；维护 `Map<cwd, count>`；把 `appWorkDir` 作为一个**合成分组**并入左侧分组列表（注意不与 `addedDirs`/SessionGroup 重复）；将聚合后的 `(cwd → count)` 传给 `Sidebar`。 |
| `src/renderer/src/components/Sidebar.tsx` | 每个分组 `group-title` 后渲染 `(N Terminal)`（N=纯终端计数，Q7）；`appWorkDir` 分组项额外渲染独立的 `+`（新建终端到 appWorkDir，Q6）；分组标题展示：项目分组用目录末段（现有逻辑），appWorkDir 分组用固定名"应用工作目录"（或目录末段 + 标记）。 |
| `src/renderer/src/components/SettingsPanel.tsx`（`TerminalSettings`） | 新增 `appWorkDir` 配置行：文本框 + 「浏览…」按钮（A3）；改动经 `pi.setConfig({ appWorkDir })` 持久化。 |
| 测试 | `integratedTerminalPool.logic.test.ts` 补计数/分组聚合单测；`IntegratedTerminal.test.tsx` 补 Sidebar 分组计数渲染；`SettingsPanel.terminal.test.tsx` 补 appWorkDir 字段。 |

## 7. 关键复用点（避免重复造轮子）

- `IntegratedTerminalInfo.cwd`（`types.ts:68`）已携带每个终端的真实 cwd，聚合计数**无需改池子逻辑**，只在渲染层按 cwd 分组即可（Q2 的"创建时归属"天然满足，因为 cwd 创建时即固定）。
- `Sidebar` 已有 `addedDirs` 补空分组的机制（`Sidebar.tsx:107-109`），`appWorkDir` 分组可复用同一"无会话也渲染分组"的思路。
- 终端创建入口 `onNewTerminal` / `createTerminal` 已有 IPC 通道，新增 `appWorkDir` 变体只需多传一个 cwd 参数。

## 8. 验收标准

1. 在目录 A 的项目会话下新建集成终端 → 左侧目录 A 分组标题后显示 `(1 Terminal)`；再开一个 → `(2 Terminal)`。
2. 在"应用工作目录"分组的 `+` 上新建终端 → 该分组标题后计数 +1；终端实际 cwd 为 `~/piDesktop`（或配置的目录）。
3. 关闭某终端（× 或 pty 退出）→ 对应分组计数实时 -1。
4. 设置面板"终端"页可查看/修改 `appWorkDir`，点「浏览…」选目录后持久化；修改不影响已开终端的归属。
5. 启动后 `~/piDesktop` 若不存在被自动创建（A2）。

## 9. 实现落地补充（code-review 后修正）

- **A1 写回持久化**：`ensureAppWorkDir()` 在 `config.appWorkDir` 缺失时补全 `DEFAULT_APP_WORK_DIR`，并经 `mergeConfig` + `writeConfigNow()` 写回 `config.json`（首次启动即固化，不依赖渲染层兜底）。
- **实时刷新（§6 硬要求已落地）**：主进程 `IntegratedTerminalPool.onExit` 回调、`terminal:create` 与 `terminal:createInAppWorkDir` handler 在创建成功后均调用 `pushTerminalList()`，经 `win.webContents.send('term:list', pool.list())` **主动推送**最新全量实例列表；渲染层 `onTerminalList` 订阅直接 `setTerminals(list)` 覆盖（无轮询，跨抽屉/多路径场景计数实时）。
- **兜底计数语义**：终端 `info.cwd` 既不等于 `appWorkDir`、也不命中任何 `SessionGroup.cwd` 时（历史/旧终端），归入**空串 `''` 兜底 key**，渲染层对该 key 不显示徽标，避免污染 `appWorkDir` 计数（与 §4/§5.3 一致）。
- **测试覆盖**：主进程集成测试新增「create 后推送 `term:list`」「onExit 后推送 `term:list`」；`integratedTerminalPool.logic.test.ts` 增 `list()` 断言；`Sidebar.test.tsx` 增 5 个新功能测试；`SettingsPanel.terminal.test.tsx` 增 2 个 appWorkDir 字段测试。完整套件与改动前基线同为 5 failed / 251 passed（5 个失败均为 pre-existing、与本次需求无关），零新回归。

