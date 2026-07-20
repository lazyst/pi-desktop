# 08 — MonacoCodeEditor 封装 + PreviewTab 切换（migrate 批1）

**What to build:** 建 `MonacoCodeEditor.tsx`（EditorSurface 的代码编辑表面），并让 `PreviewTab` 改调它，退役 `CodePreview.tsx`。用 `keepCurrentModel` 让模型跨 tab 切换保留（自然支持 keep-alive、不丢滚动），`saveViewState: false` 并由应用层 cursor/scroll 缓存恢复。图片/二进制分支保留原有 `ImagePreview` / 系统程序打开逻辑。

**Blocked by:** 07 — Monaco 依赖与本地化集成骨架（expand）

**Status:** ready-for-human

- [x] 新建 `components/editor/MonacoCodeEditor.tsx`：受控内容同步（外部变更 reconcile）、onChange→dirty、onSave、主题跟随、字号跟随、`keepCurrentModel`
- [x] `PreviewTab` 文本/代码分支改调 `MonacoCodeEditor`；图片/二进制分支保留
- [x] 退役 `CodePreview.tsx`，清理其引用（纯函数 `isExternalHref`/`resolveRelativeLink` 抽到 `linkUtils.ts`，`themeIsDark` 抽到 `editorUtils.ts`）
- [x] 测试：PreviewTab 测试 mock `MonacoCodeEditor` 通过；renderer 全量 28 文件 247 用例通过；renderer typecheck 通过；electron-vite 渲染进程构建通过
- [ ] 手动验证：打开文件→Monaco 高亮、Ctrl/Cmd+S 保存、未保存关闭确认、切走再切回恢复光标与滚动（需在桌面端手动走查）

## Comments

- 实现提交：改 `PreviewTab` 文本/代码分支调用新建 `MonacoCodeEditor`；退役 `CodePreview.tsx`。
- `CodePreview` 内的纯函数 `isExternalHref`/`resolveRelativeLink` 抽到 `linkUtils.ts`、
  `themeIsDark` 抽到 `editorUtils.ts`（markdown 渲染器 `makeLinkRenderer` 随 CodePreview 一同退役）。
- **markdown 渲染预览（CodePreview 的「编辑/预览」切换）未迁移**：issue 清单只要求
  「文本/代码 → MonacoCodeEditor」并退役 CodePreview，未列 markdown 渲染为需求，故 markdown
  现以 Monaco 纯文本编辑呈现（符合 ADR「阅读表面」基调，但丢掉了渲染视图）。若后续需要
  markdown 预览，建议在独立 issue 中基于 Monaco 的 markdown 语言 + 侧边渲染（或复用 `linkUtils`）
  重新接入，而非回到 CodePreview。
- `onOpenFile` 链接跳转能力随 markdown 渲染器退役而暂未接入 MonacoCodeEditor（PreviewTab 仍
  传递该 prop，待 markdown 预览回归时启用）。
- Ctrl/Cmd+S 保存改由 `MonacoCodeEditor` 的 `addCommand` 拥有（经 `onSave` 落盘），移除 PreviewTab
  原先重复的全局 keydown 监听，避免双绑。
- keep-alive / 视图状态：`keepCurrentModel` + `saveViewState:false`，由 `MonacoCodeEditor` 在
  `onDidChangeModel` 中按 model uri 缓存/恢复 cursor/scroll（应用层视图状态缓存，对齐 ADR-0002）。
