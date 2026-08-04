/**
 * use-terminal-container-fit-sync —— 同步终端容器 fit hook
 *
 * 移植自 Orca 的 use-terminal-container-fit-sync.ts。
 *
 * ## 为什么需要
 *
 * 侧边栏开/关是瞬时宽度变化。如果等待 ResizeObserver rAF（和 150ms 防抖的全局 fit）
 * 赶上来，终端会在 ~16ms+ 内显示错误尺寸，然后突然跳变到正确尺寸。
 *
 * 在 useLayoutEffect 中派发 SYNC_FIT_PANES_EVENT 让终端在浏览器绘制**前**同步 fit，
 * 使新容器宽度和 reflow 后的终端落在同一帧，消除可见瞬态闪烁。
 *
 * 连续拖拽（侧边栏拖宽、分栏拖拽）走独立的 ResizeObserver + 150ms 防抖路径。
 */

import { useEffect, useRef } from 'react'
import { SYNC_FIT_PANES_EVENT } from '../constants/terminal'

/**
 * 终端容器 fit 同步 hook。
 *
 * @param isVisible 容器是否可见（display:none 时跳过）
 * @param isSyncFitEnabled 是否启用同步 fit
 * @param onFitAll 同步 fit 所有终端面板的回调函数
 */
export function useTerminalContainerFitSync(
  isVisible: boolean,
  isSyncFitEnabled: boolean,
  onFitAll: () => void,
): void {
  // 使用 ref 保持回调引用稳定，避免 useEffect 因 onFitAll 引用变化而重订阅
  const onFitAllRef = useRef(onFitAll)
  onFitAllRef.current = onFitAll

  useEffect(() => {
    if (!isSyncFitEnabled || !isVisible) {
      return
    }

    const onSyncFit = (): void => {
      onFitAllRef.current?.()
    }

    window.addEventListener(SYNC_FIT_PANES_EVENT, onSyncFit)
    return () => {
      window.removeEventListener(SYNC_FIT_PANES_EVENT, onSyncFit)
    }
  }, [isSyncFitEnabled, isVisible])
}

/**
 * 派发同步 fit 事件。
 * 在侧边栏开/关等瞬时布局变化时调用，通常从 useLayoutEffect 中调用以确保在绘制前触发。
 */
export function dispatchSyncFit(): void {
  window.dispatchEvent(new CustomEvent(SYNC_FIT_PANES_EVENT))
}