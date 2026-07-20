# 09 — MonacoDiffEditor 封装 + DiffTab 切换（migrate 批2）

**What to build:** 建 `MonacoDiffEditor.tsx`（EditorSurface 的 diff 表面，同源 Monaco），让 `DiffTab` 改调 Monaco diff editor（统一主题/字号/字体跟随），退役自研 `SplitDiffView.tsx`。

**Blocked by:** 07 — Monaco 依赖与本地化集成骨架（expand）

**Status:** done

- [x] 新建 `components/editor/MonacoDiffEditor.tsx`：original/modified 双模型、主题与字号跟随、行内差异
- [x] `DiffTab` 改调 `MonacoDiffEditor`，移除对 `SplitDiffView` 的依赖
- [x] 退役 `SplitDiffView.tsx`，清理引用
- [x] 手动验证：Git 工作区改动以 Monaco diff 呈现，主题/字号切换与代码编辑器一致（含闪烁修复 `d747ff4`）
