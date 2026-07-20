# 10 — 移除 CodeMirror 依赖（contract）

**What to build:** 在 Monaco 已完全接管代码编辑与 diff（T08、T09 完成）后，从 `package.json` 移除 `@codemirror/*` 与 `codemirror`，清理残余导入，确保类型检查与构建通过。这是 expand–contract 的 contract 步。

**Blocked by:** 08 — MonacoCodeEditor 封装 + PreviewTab 切换（migrate 批1）；09 — MonacoDiffEditor 封装 + DiffTab 切换（migrate 批2）

**Status:** done

- [x] `package.json` 移除 `@codemirror/commands` / `@codemirror/lang-*` / `@codemirror/state` / `@codemirror/theme-one-dark` / `@codemirror/view` / `codemirror`
- [x] 全局搜索并清理任何残留的 codemirror 导入与类型（grep 全仓零 codemirror 导入，源码已于 T08/T09 完全迁移到 Monaco）
- [x] `pnpm typecheck` 与 `pnpm build` 通过，无未用依赖告警

> 注：移除过程中曾误删 `katex`（数学公式渲染必需，peer of `rehype-katex`，在 `main.tsx` 被 import），已立即恢复。`pnpm typecheck` 现报的 8 个错误位于 `src/main`（`node-pty` 类型与 vitest globals），与本次无关——已用 `git stash` 对照 HEAD 状态确认其为 pre-existing。
