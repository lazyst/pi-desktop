import {
  joinAbsolutePath,
  normalizeAbsolutePath,
  resolveTildePath
} from './terminal-path-normalization'

/**
 * 解析后的显式文件链接目标，包含路径文本以及可选的起始行号和列号。
 */
export type ParsedExplicitFileLinkTarget = {
  /** 路径文本（可能为相对路径、绝对路径或 ~ 开头路径） */
  pathText: string
  /** 行号（1-indexed），无指定时为 null */
  line: number | null
  /** 列号（1-indexed），无指定时为 null */
  column: number | null
}

/**
 * 解析后的显式文件链接目标，包含已解析的绝对路径以及可选的起始行号和列号。
 */
export type ResolvedExplicitFileLinkTarget = Pick<
  ParsedExplicitFileLinkTarget,
  'line' | 'column'
> & {
  /** 已解析的绝对路径 */
  absolutePath: string
}

type ParseExplicitFileLinkTargetOptions = {
  /**
   * 是否允许相对目录路径（即不带行号/列号的裸路径，且以斜杠结尾）。
   * 默认 false，此时只有绝对路径或 ~ 开头的路径才允许保留尾部斜杠。
   */
  allowRelativeDirectoryPath?: boolean
}

/**
 * 判断一个绝对路径是否允许保留尾部斜杠。
 *
 * 裸根路径（"/"、"~/"、"C:/"）作为链接目标有歧义，而带有真实路径段的绝对路径
 * 则是明确无歧义的目录。
 */
function canKeepTrailingSeparator(pathText: string): boolean {
  if (
    /^[\\/]+$/.test(pathText) ||
    /^~[\\/]$/.test(pathText) ||
    /^[A-Za-z]:[\\/]$/.test(pathText)
  ) {
    return false
  }
  return /^(?:~[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(pathText)
}

/**
 * 解析 `path:line:col` 格式的显式文件链接目标字符串。
 *
 * 支持格式：
 * - `path`（无行号列号）
 * - `path:line`（仅行号）
 * - `path:line:col`（行号 + 列号）
 *
 * @param value - 要解析的字符串
 * @param options - 可选的解析选项
 * @returns 解析后的结构，如果无法解析则返回 null
 */
export function parseExplicitFileLinkTarget(
  value: string,
  options: ParseExplicitFileLinkTargetOptions = {}
): ParsedExplicitFileLinkTarget | null {
  const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(value)
  if (!match) {
    return null
  }

  const pathText = match[1]
  const hasLineOrColumn = Boolean(match[2] || match[3])

  if (!pathText) {
    return null
  }

  // 拒绝以斜杠后跟空格开头的路径（例如 "/  "）
  if (/^[\\/]\s/.test(pathText)) {
    return null
  }

  // 处理尾部斜杠
  if (/[\\/]$/.test(pathText)) {
    const canKeepRelativeDirectory =
      options.allowRelativeDirectoryPath === true && !hasLineOrColumn
    if (
      hasLineOrColumn ||
      (!canKeepRelativeDirectory && !canKeepTrailingSeparator(pathText))
    ) {
      return null
    }
  }

  const line = match[2] ? Number.parseInt(match[2], 10) : null
  const column = match[3] ? Number.parseInt(match[3], 10) : null

  // 行号和列号必须是正数（1-indexed）
  if ((line !== null && line < 1) || (column !== null && column < 1)) {
    return null
  }

  return { pathText, line, column }
}

/**
 * 将路径文本解析为绝对路径。
 *
 * 处理三种情况：
 * 1. `~` 开头路径 → 通过 `resolveTildePath` 展开
 * 2. 绝对路径 → 通过 `normalizeAbsolutePath` 规范化
 * 3. 相对路径 → 通过 `joinAbsolutePath` 拼接到 `cwd` 上
 *
 * @param pathText - 路径文本
 * @param cwd - 当前工作目录（用于相对路径拼接）
 * @param homePath - 可选的显式 home 路径（用于 ~ 展开）
 * @returns 规范化后的绝对路径，失败时返回 null
 */
export function resolveExplicitFileLinkTargetPath(
  pathText: string,
  cwd: string,
  homePath?: string | null
): string | null {
  if (/^~[\\/]/.test(pathText)) {
    return resolveTildePath(pathText, cwd, homePath)
  }
  return (
    normalizeAbsolutePath(pathText)?.normalized ??
    joinAbsolutePath(cwd, pathText)
  )
}

/**
 * 将解析后的显式文件链接目标解析为绝对路径形式。
 *
 * @param parsed - `parseExplicitFileLinkTarget` 的返回值
 * @param cwd - 当前工作目录（用于相对路径拼接）
 * @param homePath - 可选的显式 home 路径（用于 ~ 展开）
 * @returns 包含绝对路径的行列号结构，失败时返回 null
 */
export function resolveExplicitFileLinkTarget(
  parsed: ParsedExplicitFileLinkTarget,
  cwd: string,
  homePath?: string | null
): ResolvedExplicitFileLinkTarget | null {
  const absolutePath = resolveExplicitFileLinkTargetPath(
    parsed.pathText,
    cwd,
    homePath
  )
  if (!absolutePath) {
    return null
  }

  return {
    absolutePath,
    line: parsed.line,
    column: parsed.column
  }
}