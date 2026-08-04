/**
 * terminal —— 终端相关的共享常量与事件名。
 *
 * ## SYNC_FIT_PANES_EVENT
 *
 * 侧边栏开/关等瞬时宽度变化时，通过 useLayoutEffect（浏览器绘制前）派发此事件，
 * 使终端在**同一帧**内同步 fit 到新容器尺寸，消除 ~16ms 的"旧列宽+新容器宽"闪烁。
 *
 * 连续拖拽（侧边栏拖宽、分栏拖拽）走独立 ResizeObserver + 防抖/稳定网格路径。
 */

/** 同步 fit 所有终端面板的自定义事件名。 */
export const SYNC_FIT_PANES_EVENT = 'pi-sync-fit-panes'