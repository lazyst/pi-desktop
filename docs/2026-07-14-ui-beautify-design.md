# Pi Desktop — UI 美化设计文档（Spec）

- **日期**：2026-07-14
- **状态**：已确认（brainstorming 设计阶段通过，待进入实现计划）
- **关联文档**：`docs/2026-07-14-pi-desktop-design.md`（应用架构 spec，本 spec 只改视觉层，不动架构/IPC）
- **目标**：在不改动现有功能、数据结构、IPC 契约的前提下，对渲染进程（侧栏、标题栏、终端、弹窗）的视觉与字体做整体打磨。

## 1. 设计决策（来自 brainstorming）

| 维度 | 决策 |
|---|---|
| 视觉方向 | 打磨现有深色开发者工具风（不换风格，提质） |
| 字体策略 | 统一等宽：终端与界面共用同一等宽编程字体（JetBrains Mono / Fira Code / Cascadia Code，带连字） |
| 主色 / 强调色 | 冷蓝 `#7c9cff`，用于激活态、焦点环、高亮；整体仍偏中性 |
| 实现方式 | 设计令牌系统：CSS 变量集中管理，替换散落的 inline style |

## 2. 设计令牌（tokens.css）

所有值定义在 `:root`，组件样式只引用变量，禁止硬编码色值/尺寸。

### 2.1 配色

```css
:root {
  /* 背景层次 */
  --bg-app:        #0d1117;            /* 应用主背景（原 #0c0c0c 收敛为略带蓝的深黑） */
  --bg-panel:      #161b22;            /* 侧栏 / 标题栏（原 #16161e） */
  --bg-hover:      #1c2230;            /* 列表项 hover */
  --bg-active:     rgba(124,156,255,.10); /* 激活项底色（冷蓝淡染） */
  --bg-elevated:   #1b2230;            /* 弹窗 */

  /* 边框 */
  --border:        #283040;            /* 分隔线 / 边框（原 #2a2a36 调冷） */
  --border-strong: #36405a;            /* 输入框 / 弹窗边框 hover */

  /* 文字 */
  --text:          #c9d1d9;            /* 主文字（原 #d4d4d8） */
  --text-muted:    #8b949e;            /* 次级文字（原 #8b8b98） */
  --text-faint:    #6e7681;            /* 时间 / 路径等弱信息 */

  /* 主色 / 语义色 */
  --accent:        #7c9cff;            /* 冷蓝主色 */
  --accent-hover:  #93acff;            /* 主色 hover */
  --success:       #3fb950;            /* 运行中 */
  --danger:        #f85149;            /* 错误 / 终止 */
  --danger-hover:  #ff6b62;
  --focus-ring:    0 0 0 2px rgba(124,156,255,.55); /* 焦点环 */
}
```

### 2.2 字体

```css
:root {
  --font-mono: 'JetBrains Mono','Fira Code','Cascadia Code',
               ui-monospace, SFMono-Regular, Menlo, Consolas,
               'Liberation Mono', monospace;

  --fs-xs: 11px;   /* 分组标题、时间 */
  --fs-sm: 12px;   /* 列表次级 */
  --fs-md: 13px;   /* 正文 / 终端 */
  --fs-lg: 14px;   /* 标题栏 */
  --fs-xl: 16px;   /* 大标题 */

  --fw-regular: 400;
  --fw-medium:  500;
  --fw-semibold:600;

  --lh-tight: 1.3;
  --lh-base:  1.45;   /* 终端行高 */
  --ls-label: .02em;  /* 标签字距 */
}
```

- 字体随应用**本地打包**：通过 `@font-face` 引入 JetBrains Mono 的 woff2（regular / medium / semibold），放在 `src/renderer/src/assets/fonts/`，离线可用。
- 保留上面的系统等宽回退栈兜底（字体文件缺失/未打包时仍能正常显示）。
- 终端字号 `--fs-md`（13px）、行高 `--lh-base`（1.45）。
- **限制说明**：xterm.js 按字符格逐格渲染，**连字在终端内不会合成**；连字只体现在 UI 文字（标题、标签）上。终端 `fontFamily` 仍指向 `--font-mono` 栈以保证统一。

### 2.3 间距 / 圆角 / 阴影 / 动效

```css
:root {
  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px; --sp-5: 20px;
  --r-sm: 6px;  --r-md: 8px;  --r-lg: 12px;
  --shadow-modal: 0 10px 40px rgba(0,0,0,.55);
  --transition: 140ms ease;
}
```

## 3. 布局（保持现有三区结构，只提质）

```
┌──────────────┬───────────────────────────────┐
│  会话          │  name · cwd        ● 运行中    │ ← 标题栏：底部冷蓝细线
│ [+目录][+会话] │───────────────────────────────│
│ 📁 cwd         │                               │
│ ▏name    ●    │         (xterm 终端)           │ ← 激活轨 + 淡染底色
│ ▏name    ●    │                               │
│   name        │                               │
└──────────────┴───────────────────────────────┘
   280px 侧栏          终端主区
```

- **侧栏（280px）**：分组目录标题用 `--text-faint` / `--fs-xs` 弱化；会话项 `padding` 用 token；hover → `--bg-hover`；激活项 → 左侧 2px `--accent` 竖条（激活轨）+ `--bg-active` 淡染底色。
- **标题栏（34px）**：底部一条 1px `--accent`（或 `--border` + accent 收口）细线；左侧会话名 `--fs-lg` `--fw-semibold`；状态点用 `--success`/`--text-muted`；错误提示用 `--danger`。
- **终端主区**：保留方形（终端惯例，不加圆角）；统一内边距 `--sp-2` 与底色 `--bg-app`。
- **弹窗（modal）**：`--bg-elevated` + `--r-md` + `--shadow-modal`；输入框 `--bg-app` 底、`--border` 边，focus 时 `--border-strong` + `--focus-ring`。
- **滚动条**：沿用细滚动条，颜色由 `#2a2a36` 收敛为 `--border`。

## 4. 签名元素（Signature）

**冷蓝"激活轨"**：侧栏当前会话左侧一条 2px `--accent` 竖条，配合 `--bg-active` 淡染底色与发光状态点，使"当前在哪个会话"一眼可辨。

**全局冷蓝焦点环**：所有可聚焦元素（按钮、输入框、会话项）在 `:focus-visible` 时显示 `--focus-ring`。既是应用身份，又满足键盘可达性。

这是全页唯一的高调记忆点，其余一律安静克制。

## 5. 动效（克制）

- hover 底色 / 文字：`transition: background-color, color var(--transition)`。
- 激活轨淡入（`opacity` / `transform`）。
- 状态点轻微 `box-shadow` 发光。
- `@media (prefers-reduced-motion: reduce)` 下关闭所有过渡与发光。
- 不堆砌动画，避免"AI 生成感"。

## 6. 实现方案（文件级）

### 6.1 新增文件

- `src/renderer/src/styles/tokens.css`
  - `:root` 变量（§2 全部令牌）
  - `@font-face` 引入本地 JetBrains Mono woff2（regular/medium/semibold）
  - `html, body` 基础：`height:100%`、`background:var(--bg-app)`、`color:var(--text)`、`font-family:var(--font-mono)`、`font-size:var(--fs-md)`
  - 全局 `:focus-visible` 焦点环、`prefers-reduced-motion` 关闭过渡
  - 细滚动条样式（用 `--border`）
- `src/renderer/src/styles/app.css`
  - 语义化 class：`.app-shell` `.sidebar` `.sidebar-header` `.sidebar-btn` `.group` `.group-title` `.session-item` `.session-item.active` `.session-dot` `.session-dot.running` `.terminate` `.header` `.header-title` `.header-status` `.header-error` `.modal-overlay` `.modal` `.modal-label` `.modal-input` `.modal-actions` `.btn` 等

### 6.2 字体资源

- `src/renderer/src/assets/fonts/jetbrains-mono-*.woff2`（regular 400 / medium 500 / semibold 600）
- 实现时优先从官方源获取并放入；若离线无法获取，则保留 §2.2 的回退栈，spec 不阻塞（UI 仍用系统等宽，统一度略降但不影响功能）。

### 6.3 改动文件

- `src/renderer/src/main.tsx`：顶部 `import './styles/tokens.css'` 与 `import './styles/app.css'`（顺序：tokens 在前）。
- `src/renderer/src/App.tsx`：
  - 移除根节点 inline style，改用 `.app-shell`。
  - 标题栏改用 `.header` / `.header-title` / `.header-status` / `.header-error`（token 化）。
  - 保留现有 `<style>` 中滚动条/`.session-item:hover .terminate` 逻辑，迁移进 `app.css`（不再用组件内 `<style>`）。
- `src/renderer/src/components/Sidebar.tsx`：
  - 所有 inline style 改为语义 class（`.sidebar` `.sidebar-header` `.sidebar-btn` `.group` `.group-title` `.session-item` `.session-item.active` `.session-dot` `.terminate` `.modal-*`）。
  - 激活项加 `.active`（激活轨 + 淡染）。
  - 弹窗样式 token 化。
- `src/renderer/src/components/TerminalPane.tsx`：
  - `new Terminal({ fontFamily: var(--font-mono) 对应栈, fontSize: 13, ... })` → 用常量字符串 `FONT_MONO`（与 `--font-mono` 同栈，因 xterm 不读 CSS 变量）。
  - 宿主 `div` 背景改 `--bg-app`、内边距 token（可在 `app.css` 用 `.terminal-host` 定义）。

### 6.4 不在范围内（明确不做）

- 不改架构、IPC、进程池、会话模型（见架构 spec）。
- 不引入浅色主题、不新增设置面板。
- 不做多终端分屏 / 标签页（属架构 spec 的范围外）。
- 不替换 xterm 或 node-pty。

## 7. 质量底线（Acceptance）

1. **视觉一致**：全应用无硬编码色值/尺寸，全部来自 tokens；暗色基调统一、冷蓝主色仅在激活/焦点/高亮出现。
2. **字体统一**：侧栏、标题栏、弹窗、终端均使用同一等宽字体栈；终端 13px / 行高 1.45。
3. **键盘可达**：Tab 聚焦按钮、输入框、会话项时可见冷蓝焦点环；`:focus-visible` 生效。
4. **reduced-motion**：系统开启减少动效后，过渡/发光关闭，功能不受影响。
5. **响应式**：窄屏（如窗口 < 640px）侧栏缩窄或保持可用；终端仍正确 fit。
6. **功能不变**：会话列表、绿点、hover 终止、新建目录/会话、弹窗输入、终端续跑等行为与改动前一致（用现有 e2e/单测回归）。
7. **无回归**：`pnpm test`（vitest）与 `pnpm test:e2e`（playwright）通过。

## 8. 验证方式

- 视觉：启动 `pnpm dev`，逐项核对 §3 布局与 §4 签名元素；截图对比前后。
- 可达性：键盘 Tab 走查焦点环；系统开启"减少动效"后复查。
- 回归：运行 `pnpm test` 与 `pnpm test:e2e`（现有会话管理 / 终端续跑用例）。

## 9. 风险与对策

- **字体打包失败（离线）**：回退到系统等宽栈，UI 仍统一；spec 不阻塞。
- **xterm 不读 CSS 变量**：终端 `fontFamily` 用与 `--font-mono` 同栈的 JS 常量字符串，保证一致。
- **inline style 与 class 冲突**：迁移时逐组件核对，确保旧 inline 完全移除，避免特异性相互抵消（特别是 section 与 element 级选择器的 padding/margin）。
- **CSS 特异性冲突**：组件 class 采用扁平、单一职责命名，避免 `.section` 与 `.cta` 这类互相抵消的选择器。
