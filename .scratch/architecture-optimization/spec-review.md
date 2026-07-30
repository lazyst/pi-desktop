# Spec Review: Architecture Optimization

## A) Missing / Partial Requirements

**1. useSidebarState hook (Decision 7) — NOT created**
Spec: "将 App.tsx 中的状态按职责分组提取为 3 个 hooks：useSidebarState, useSessionStatus, usePanelLayout"
Only 2 hooks were created (`usePanelLayout`, `useSessionStatus`). The sidebar state (`disk`, `pinned`, `addedDirs`, `appWorkDir`, `collapsedGroups`, `liveUnsaved`) remains inline in App.tsx unchanged.

**2. `_virtualToPty` moved to useSessionStatus.ts — contradicts spec**
Spec: "`_virtualToPty` 作为模块级变量保留在 App.tsx 中，不从 App.tsx 移入 hooks...useSessionStatus hook 通过参数或 ref 引用它"
Implementation moves it to `useSessionStatus.ts` (module-level, exported). While functional, this is a spec deviation.

**3. `selectNextTabOnClose` function signature differs from spec (Decision 6)**
Spec: `(tabs: Tab[], activeTabId, cwdTabHistory, cwd) => { nextTabId, nextCwdActiveTab }`
Implementation: `(remaining, removedId, removedCwd, activeTabId, activeCwd, cwdActiveTab, cwdTabHistory) => { activeTabId, cwdActiveTab, cwdTabHistory } | null`
The implementation adds 3 extra parameters (`removedId`, `removedCwd`, `activeCwd`) and includes `cwdActiveTab` in the return. The return type also differs (null vs. both fields present). The richer signature is more correct, but it does not match the spec.

**4. No tests for `selectNextTabOnClose`**
Testing Decisions: "selectNextTabOnClose — 纯函数测试（现有先例：tabStore.test.ts）"
No test file was added for this function.

## B) Scope Creep / Unintended Changes

**5. configHandlers.ts: restore timeout changed 20ms → 50ms**
Original `main/index.ts`:
```
setTimeout(() => { if (win.isDestroyed()) return; win.setOpacity(1); }, 20);
```
Extracted `configHandlers.ts`:
```
setTimeout(() => { if (!win.isDestroyed()) win.setOpacity(1); }, 50);
```
This is a behavioral change (not just extraction). The spec says "each operation does not change any external behavior".

## C) Implementation Looks Correct

All other requirements are faithfully implemented:
- **01**: ReferenceCountedWatcher with watch/unwatch/dispose, replaces 3 watcher patterns, cooldown preserved
- **02**: All 13+ terminal handlers moved with correct signature
- **03**: All session handlers + config/window handlers moved with correct signatures
- **04**: All fs/git handlers moved with ReferenceCountedWatcher integration
- **07**: 5 pure functions extracted, re-exported from both source files, unifiedTerminalPool.ts updated, 15 tests
- **08**: IPtyLike moved to types.ts, imports updated
- **11**: 6 call sites replaced with selectNextTabOnClose (all 6 + 2 branches of closeCenterTab = 7 call sites)
- **12**: usePanelLayout hook with all 4 panel states
- **13**: useSessionStatus hook with all IPC subscriptions moved