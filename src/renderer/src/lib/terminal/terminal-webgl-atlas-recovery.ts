/**
 * terminal-webgl-atlas-recovery —— WebGL 纹理图集恢复策略
 *
 * 在多种场景下自动触发 WebGL 纹理图集重建，防止因纹理污染/过期导致的渲染异常。
 *
 * ## 设计思路（对齐 Orca terminal-webgl-atlas-recovery.ts）
 *
 * WebGL 渲染器使用纹理图集缓存字形位图。当：
 *   - 粘贴图片后，图片纹理可能污染图集
 *   - Tab 切回时，缓存的图集可能已过期（其他 Tab 的 WebGL 实例可能修改了共享资源）
 *   - 终端输出大量数据后，图集可能因内部状态不一致而损坏
 *
 * 图集恢复流程：
 *   1. clearTextureAtlas() — 清空 WebGL 纹理图集
 *   2. requestAnimationFrame() — 等待一帧确保图集已清空
 *   3. refreshAllPanes() — 触发所有终端重绘，重建图集
 *
 * 恢复调用带防抖，避免高频触发（如连续粘贴时）。
 */

// ─── 防抖配置 ──────────────────────────────────────────────────────────────

/** 输出后恢复的安静期（毫秒）：输出频繁时不触发恢复，输出停止后才触发。 */
const OUTPUT_RECOVERY_QUIET_MS = 2000

/** 粘贴后恢复的延时（毫秒）：粘贴后立即重置，但防抖避免重复触发。 */
const PASTE_RECOVERY_DEBOUNCE_MS = 300

/** Tab 显示后恢复的延时（毫秒）：切 Tab 后等待布局稳定再重置。 */
const TAB_REVEAL_RECOVERY_DEBOUNCE_MS = 100

/** 恢复后重绘的帧数（每次 clearTextureAtlas 后刷新 N 次，确保纹理完全重建）。 */
const REFRESH_FRAME_COUNT = 3

/** 帧间间隔（毫秒）。 */
const REFRESH_FRAME_INTERVAL_MS = 250

// ─── 模块级状态 ────────────────────────────────────────────────────────────

let outputRecoveryTimer: ReturnType<typeof setTimeout> | null = null
let pasteRecoveryTimer: ReturnType<typeof setTimeout> | null = null
let tabRevealRecoveryTimer: ReturnType<typeof setTimeout> | null = null

// ─── 内部实现 ──────────────────────────────────────────────────────────────

/**
 * 执行一次图集恢复：清空纹理图集 → 等待一帧 → 重复刷新多次。
 * 使用 requestAnimationFrame 确保在浏览器渲染帧中执行。
 */
// 模块级引用：由 initWebglAtlasRecovery 设置，避免循环依赖 require
let _resetAndRefreshAtlases: (() => void) | null = null

/**
 * 初始化 WebGL 图集恢复模块，传入实际的 resetAndRefreshAllTerminalWebglAtlases 函数。
 * 在模块加载时由 terminal-registry 调用一次，避免循环依赖。
 */
export function initWebglAtlasRecovery(
  resetFn: () => void
): void {
  _resetAndRefreshAtlases = resetFn
}

function clearAndRefreshAtlases(): void {
  const resetFn = _resetAndRefreshAtlases
  if (!resetFn) return
  resetFn()

  // 在后续帧中重复刷新，确保纹理完全重建
  let frameCount = 1
  function scheduleNextFrame(): void {
    if (frameCount >= REFRESH_FRAME_COUNT) return
    frameCount++
    requestAnimationFrame(() => {
      resetFn()
      setTimeout(scheduleNextFrame, REFRESH_FRAME_INTERVAL_MS)
    })
  }
  // 第一帧恢复
  requestAnimationFrame(() => {
    resetFn()
    setTimeout(scheduleNextFrame, REFRESH_FRAME_INTERVAL_MS)
  })
}

// ─── 公开 API ──────────────────────────────────────────────────────────────

/**
 * 调度输出后 WebGL 图集恢复（带防抖）。
 * 适用于终端输出大量数据后，防止图集状态不一致。
 * 防抖：输出频繁时不触发，输出停止 OUTPUT_RECOVERY_QUIET_MS 后触发。
 */
export function scheduleTerminalWebglAtlasRecovery(): void {
  if (outputRecoveryTimer !== null) {
    clearTimeout(outputRecoveryTimer)
  }
  outputRecoveryTimer = setTimeout(() => {
    outputRecoveryTimer = null
    clearAndRefreshAtlases()
  }, OUTPUT_RECOVERY_QUIET_MS)
}

/**
 * 调度粘贴后 WebGL 图集恢复（带防抖）。
 * 适用于粘贴图片后，防止图片纹理污染图集。
 * 防抖：连续粘贴时不重复触发。
 */
export function scheduleImagePasteWebglAtlasRecovery(): void {
  if (pasteRecoveryTimer !== null) {
    clearTimeout(pasteRecoveryTimer)
  }
  pasteRecoveryTimer = setTimeout(() => {
    pasteRecoveryTimer = null
    clearAndRefreshAtlases()
  }, PASTE_RECOVERY_DEBOUNCE_MS)
}

/**
 * 调度 Tab 显示后 WebGL 图集恢复（带防抖）。
 * 适用于 Tab 切回时，防止缓存的图集过期。
 * 延时短，确保布局稳定后立即重置。
 */
export function scheduleTabRevealWebglAtlasRecovery(): void {
  if (tabRevealRecoveryTimer !== null) {
    clearTimeout(tabRevealRecoveryTimer)
  }
  tabRevealRecoveryTimer = setTimeout(() => {
    tabRevealRecoveryTimer = null
    clearAndRefreshAtlases()
  }, TAB_REVEAL_RECOVERY_DEBOUNCE_MS)
}

/**
 * 取消所有待处理的图集恢复调度。
 * 适用于 unmount 或全局清理时。
 */
export function cancelAllWebglAtlasRecoveries(): void {
  if (outputRecoveryTimer !== null) {
    clearTimeout(outputRecoveryTimer)
    outputRecoveryTimer = null
  }
  if (pasteRecoveryTimer !== null) {
    clearTimeout(pasteRecoveryTimer)
    pasteRecoveryTimer = null
  }
  if (tabRevealRecoveryTimer !== null) {
    clearTimeout(tabRevealRecoveryTimer)
    tabRevealRecoveryTimer = null
  }
}