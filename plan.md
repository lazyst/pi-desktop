# 为 Pi 会话查看添加 Markdown 渲染

## 背景

当前 `SessionContentView` 组件（弹窗 + 中间区域 tab）读取历史会话消息后，按轮次分组展示，但所有消息内容均为纯文本。Pi 的回复是 markdown 格式，缺少渲染导致代码块、表格、数学公式、mermaid 图表等无法正常显示。

## 决策记录

| # | 问题 | 决策 |
|---|------|------|
| Q1 | 覆盖范围 | `SessionContentView`（弹窗）和 `session-content` tab（中间区域）**两者都要** |
| Q2 | 渲染边界 | 只对 **assistant（Pi）角色的消息**做 markdown 渲染，user/tool 消息保持纯文本 |
| Q3 | tool 消息处理 | 用 `<pre><code>` 代码块包裹 + 语法高亮 |
| Q4 | 渲染组件 | **新建 `SessionMarkdownRenderer`**，复用 `MarkdownPreview` 的插件链，去掉文件路径解析耦合 |
| Q5 | 消息内字段 | 只对 **finalText（最终回复）**做 markdown 渲染，thinking 思考过程和 user 消息保持纯文本 |

## 实施步骤

### Step 1 — 创建 `SessionMarkdownRenderer` 组件

**文件**: `src/renderer/src/components/SessionMarkdownRenderer.tsx`

从 `MarkdownPreview.tsx` 中提取核心渲染能力，去掉文件路径相关的 props 和逻辑：

- 保留：react-markdown + remark-gfm/breaks/frontmatter/math + rehype-raw/sanitize/slug/highlight/katex 插件链
- 保留：mermaid 代码块渲染（MermaidBlock 组件）
- 保留：代码块复制按钮
- 保留：右键菜单（复制/全选/复制链接地址）
- 保留：sanitize schema
- **去掉**：`filePath`、`root`、`onOpenFile` props
- **去掉**：`resolveImageSrc` / `resolveLinkTarget` 文件路径解析
- **去掉**：目录（TOC）侧边栏（会话内容不需要导航目录）
- 修改：外部链接走 `pi.openExternal`，内部 `#anchor` 链接平滑滚动
- 修改：图片直接用 `src` 原样渲染（不解析相对路径）

**Props**:
```typescript
interface Props {
  content: string;
}
```

### Step 2 — 修改 `SessionContentView`

**文件**: `src/renderer/src/components/SessionContentView.tsx`

- 导入 `SessionMarkdownRenderer`
- `finalText` 有两个渲染位置，**都需要**替换：
  1. 有 process 分支：`<div className="session-msg-content session-msg-final">{group.finalText}</div>`
  2. 无 process 分支：`<div className="session-msg-content">{group.finalText}</div>`
- 替换为 `<SessionMarkdownRenderer content={group.finalText} />`，**放在 `.session-msg-content` 外部**，使用独立 wrapper 类名 `.session-markdown-renderer`
- tool 消息的 `content`：用 `<pre><code className="hljs">{t.content}</code></pre>` 包裹，不引入额外 markdown 解析管道

### Step 3 — 调整 CSS 样式

**文件**: `src/renderer/src/styles/app.css`

- 新增 `.session-markdown-renderer` 类，覆盖 `white-space: normal`，避免与 `.session-msg-content` 的 `pre-wrap` 冲突
- 若复用 `.markdown-file-preview` 样式，覆盖 `padding: 24px 28px` 为 `8px 12px`（会话视图宽度有限）
- 代码块、表格、引用等元素在有限宽的会话视图中正常显示
- 与现有的 `.session-msg-content` 和 `.session-msg-final` 样式协调

## 架构影响

- 无新增 npm 依赖（所有插件已由 `MarkdownPreview` 引入）
- `SessionContentView` 保持现有 props 不变
- `SplitPane.tsx` 无需修改
- 两个入口（弹窗 + tab）同时受益