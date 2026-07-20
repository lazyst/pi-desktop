# 11 — @dnd-kit 同 location 拖拽重排

**What to build:** 用 `@dnd-kit/core` + `@dnd-kit/sortable` 为 tab 条加上同 location 内拖拽重排（ADR-0001 的 `TabReorder`）。拖拽仅改 store 中 `order`，不碰渲染实例（keep-alive 不受影响）。editor 与 panel 各自区域内排序。

**Blocked by:** 03 — CenterPane / TabBar / TerminalDrawer 改造为从 store 取数（store 已含 `reorderTabs`）

**Status:** ready-for-agent

- [ ] `TabBar` 接入 `@dnd-kit/sortable`，拖拽结束后调用 `reorderTabs(location, orderedIds)`
- [ ] 拖拽仅更新 `order`，不触发内容组件卸载/重建
- [ ] editor 区与 panel 区（终端 tab）各自独立排序，不跨区
- [ ] 手动验证：拖动 tab 改变顺序并保持；切换/关闭其他 tab 后顺序稳定
