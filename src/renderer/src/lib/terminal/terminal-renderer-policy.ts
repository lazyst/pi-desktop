/**
 * terminal-renderer-policy —— 终端渲染器策略（对齐 Orca terminal-renderer-policy.ts）
 *
 * 根据终端内容类型决定使用 WebGL 还是 DOM 渲染器。
 * 某些 TUI 程序在 WebGL 渲染器下可能出现光标抖动、渲染失真等问题，
 * 降级到 DOM 渲染器可消除这些问题。
 *
 * ## 设计思路
 *
 * 渲染器选择优先级：
 *   1. 用户设置 `off` → 强制 DOM（即使 WebGL 可用）
 *   2. WebGL 不可用 / 上下文丢失 → 强制 DOM
 *   3. 用户设置 `on` → 强制 WebGL
 *   4. `auto` 模式 → 根据终端标题判定兼容性
 *      - 标题包含 TUI 特征（如 Braille 前缀、特定关键字）→ DOM
 *      - 其他 → WebGL
 *
 * ## 与 enableWebgl 的关系
 *
 * 本模块提供决策结果，实际的 WebGL 加载/卸载由 XtermTerminal 的
 * enableWebgl() / retryWebglIfNeeded() 执行。本模块不直接操作 DOM 或 WebGL。
 */

// ─── 类型定义 ──────────────────────────────────────────────────────────────

/** 终端 GPU 加速模式（用户设置）。 */
export type TerminalGpuAccelerationMode = 'auto' | 'on' | 'off'

/** 渲染器策略决策结果。 */
export type RendererPolicyDecision = {
  /** 是否启用 GPU 渲染。 */
  gpuEnabled: boolean
  /** 决策原因。 */
  reason: 'user-setting' | 'capability' | 'context-loss' | 'agent-compatibility'
  /** 决策置信度。 */
  confidence: 'authoritative' | 'fallback'
}

/** 渲染器策略决策输入。 */
export type ResolveRendererPolicyInput = {
  /** 终端原始标题（来自 OSC 0 序列）。 */
  rawTitle: string | null
  /** 用户 GPU 设置。 */
  userGpuMode: TerminalGpuAccelerationMode
  /** WebGL 是否不可用（如浏览器不支持）。 */
  webglUnavailable?: boolean
  /** 是否处于 WebGL 上下文丢失状态。 */
  inContextLossContainment?: boolean
}

// ─── TUI 特征检测 ──────────────────────────────────────────────────────────

/** Braille 字符范围（U+2800–U+28FF），pi 扩展 spinner 帧的字符集。 */
const BRAILLE_RE = /^[\u2800-\u28FF]/

/**
 * 检测终端标题是否包含 TUI 特征（提示当前运行的是 TUI 程序而非普通 shell）。
 *
 * TUI 特征包括：
 *   - Braille 前缀（pi 扩展 spinner 帧）
 *   - 已知的 TUI 程序名称（vim, nano, htop 等）
 *   - TUI 框架特征（如 Codex, Claude Code 等）
 */
function isTuiTitle(rawTitle: string): boolean {
  // Braille 前缀：pi 扩展 spinner 正在运行
  if (BRAILLE_RE.test(rawTitle)) return true

  const lower = rawTitle.toLowerCase()

  // 常见 TUI 程序
  const tuiKeywords = [
    'vim', 'nvim', 'neovim', 'emacs', 'nano', 'micro',
    'htop', 'top', 'btm', 'bottom',
    'less', 'more', 'most',
    'tmux', 'screen',
    'git log', 'git diff', 'git blame',
    'man ',
    'tui', 'terminal ui',
    // agent TUI
    'codex', 'claude code', 'cursor',
  ]

  return tuiKeywords.some((keyword) => lower.includes(keyword))
}

// ─── 决策函数 ──────────────────────────────────────────────────────────────

/**
 * 解析终端渲染器策略。
 *
 * 优先级：
 *   1. 用户设置 `off` → 强制 DOM
 *   2. WebGL 不可用 / 上下文丢失 → 强制 DOM
 *   3. 用户设置 `on` → 强制 WebGL
 *   4. `auto` 模式 → 根据标题判定兼容性
 *      - 标题包含 TUI 特征 → 降级 DOM（避免 WebGL 光标抖动）
 *      - 其他 → 保持 WebGL
 */
export function resolveRendererPolicy(
  input: ResolveRendererPolicyInput
): RendererPolicyDecision {
  const { rawTitle, userGpuMode } = input

  // 优先级 1：用户设置 off → 强制 DOM
  if (userGpuMode === 'off') {
    return {
      gpuEnabled: false,
      reason: 'user-setting',
      confidence: 'authoritative',
    }
  }

  // 优先级 2：WebGL 不可用 / 上下文丢失 → 强制 DOM
  if (input.inContextLossContainment) {
    return {
      gpuEnabled: false,
      reason: 'context-loss',
      confidence: 'authoritative',
    }
  }
  if (input.webglUnavailable) {
    return {
      gpuEnabled: false,
      reason: 'capability',
      confidence: 'authoritative',
    }
  }

  // 优先级 3：用户设置 on → 强制 WebGL
  if (userGpuMode === 'on') {
    return {
      gpuEnabled: true,
      reason: 'user-setting',
      confidence: 'authoritative',
    }
  }

  // 优先级 4：auto 模式 → 根据标题判定兼容性
  // 如果标题包含 TUI 特征，降级为 DOM 渲染器以避免光标抖动
  if (rawTitle && isTuiTitle(rawTitle)) {
    return {
      gpuEnabled: false,
      reason: 'agent-compatibility',
      confidence: 'fallback',
    }
  }

  // 默认：保持 WebGL
  return {
    gpuEnabled: true,
    reason: 'capability',
    confidence: 'authoritative',
  }
}