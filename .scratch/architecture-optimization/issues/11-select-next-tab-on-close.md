# 11 — selectNextTabOnClose 纯函数提取 + 替换 6 处

**What to build:** 将 `tabStore.ts` 中 6 个 action 重复的"关闭后找下一个 tab"模式提取为 `selectNextTabOnClose` 纯函数，逐一替换。

**Blocked by:** None — can start immediately.

**Status:** completed

- [x] 在 `tabStore.ts` 中实现 `selectNextTabOnClose` 纯函数
- [x] 替换 `closeTab` 中的重复模式
- [x] 替换 `hideTab` 中的重复模式
- [x] 替换 `setHidden` 中的重复模式
- [x] 替换 `removeSessionTab` 中的重复模式
- [x] 替换 `removeTerminalTab` 中的重复模式
- [x] 替换 `closeCenterTab` 中的**两个分支**的重复模式
- [x] 验证 `pnpm test` 通过（35/37 通过，2 个 pre-existing 失败）