/* eslint-disable max-lines -- Why: terminal link parsing depends on ordered passes sharing range state. */
import { normalizeAbsolutePath } from './terminal-path-normalization'
import {
  parseExplicitFileLinkTarget,
  resolveExplicitFileLinkTarget
} from './explicit-file-link-target'

export type ParsedTerminalFileLink = {
  pathText: string
  line: number | null
  column: number | null
  startIndex: number
  endIndex: number
  displayText: string
}

export type ResolvedTerminalFileLink = Pick<ParsedTerminalFileLink, 'line' | 'column'> & {
  absolutePath: string
}

// 移植自 VSCode 的终端链接检测器（MIT）：`terminalLocalLinkDetector.ts` 的本地路径，
// 以及 `terminalWordLinkDetector.ts` 的裸单词。
// 两阶段检测与 VSCode 一致：含分隔符路径优先，然后保守的裸文件名 Token
// 只有在能对照 cwd 解析时才成为链接。

// 匹配包含至少一个 `/` 分隔符的路径，可选 `:line` 和 `:col` 后缀
// （例如 `src/foo.ts:12:3`、`./bin`、`/abs/path`）。
// 为什么：框架路由文件常用括号/方括号分段（如 `app/(shop)/products/[id]/page.tsx`），
// 保持这些链接完整。
const LOCAL_PATH_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[A-Za-z0-9._~\-/%+@\\()[\]]*(?::\d+)?(?::\d+)?/g

// 匹配文件或文件夹名中包含空格的含分隔符路径。在 LOCAL_PATH_REGEX 之前运行，
// 这样 `/Users/A/Foo Bar/file.ts` 被作为一个链接捕获，而不是被拆分为
// `/Users/A/Foo` 和 `Bar/file.ts`。
// 为什么故意设宽：在正则内部验证"空格后跟后续分隔符"会在大型 ConPTY TUI 行上
// 产生重叠的空格回溯。保持线性扫描，在代码中过滤候选。
const SPACED_PATH_WITH_SEPARATOR_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|`\r\n]+(?::\d+)?(?::\d+)?/g
// 为什么同样宽：扩展名路径后跟散文仍然需要裁剪，但空白/扩展名测试在代码中。
const SPACED_PATH_WITH_EXTENSION_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|`\r\n]+(?::\d+)?(?::\d+)?/g
// 为什么也同样宽：候选路径在悬停时运行，包括巨大的空格填充 TUI 行，
// 所以在正则外部拒绝行尾空格路径。
const LINE_ENDING_SPACED_PATH_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|`\r\n]+(?::\d+)?(?::\d+)?/g
const SPACED_LOCAL_PATH_REGEXES = [
  SPACED_PATH_WITH_SEPARATOR_REGEX,
  SPACED_PATH_WITH_EXTENSION_REGEX,
  LINE_ENDING_SPACED_PATH_REGEX
]

// 裸文件名阶段使用的单词分隔符。与 VSCode `terminal.integrated.wordSeparators`
// 默认集一致，不同之处在于我们通过 `:line:col` 后缀解析器间接包含 `:`，
// 而不是将其作为原始分隔符。单词是任何非分隔符字符的最大连续序列。
// \s 在现代 JS 中匹配 NBSP；xterm powerline 字形在 PUA 中，从不出现在文件名中，
// 所以我们不显式列出它们。
const WORD_TOKEN_REGEX = /[^\s()[\]{}'",;<>|`]+/g

const LEADING_TRIM_CHARS = new Set(['(', '[', '{', '"', "'"])
const TRAILING_TRIM_CHARS = new Set([')', ']', '}', '"', "'", ',', ';', '.'])

function trimBoundaryPunctuation(
  value: string,
  startIndex: number
): { text: string; startIndex: number; endIndex: number } | null {
  let start = 0
  let end = value.length

  while (start < end && LEADING_TRIM_CHARS.has(value[start])) {
    start += 1
  }
  while (end > start && TRAILING_TRIM_CHARS.has(value[end - 1])) {
    end -= 1
  }

  if (start >= end) {
    return null
  }

  return {
    text: value.slice(start, end),
    startIndex: startIndex + start,
    endIndex: startIndex + end
  }
}

// 没有扩展名但看起来像文件名的项目文件。单词检测器否则要求 Token 中有 `.`
// 以降低噪音——如果没有这个列表，`ls` 输出中的 `Makefile` 或 `LICENSE` 将不可点击。
const EXTENSIONLESS_FILENAMES = new Set([
  'Makefile',
  'Dockerfile',
  'Rakefile',
  'Gemfile',
  'Procfile',
  'LICENSE',
  'README',
  'CHANGELOG',
  'AUTHORS',
  'NOTICE',
  'CONTRIBUTING'
])

const BARE_FILENAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/
const URI_PREFIX_CHAR_PATTERN = /^[A-Za-z0-9+./:-]$/
const MAX_BARE_FILENAME_TOKEN_LENGTH = 120

function hasPathSeparator(text: string): boolean {
  return text.includes('/') || text.includes('\\')
}

function hasSeparatorAfterWhitespace(text: string): boolean {
  let sawWhitespace = false
  for (const char of text) {
    if (/\s/.test(char)) {
      sawWhitespace = true
      continue
    }
    if (sawWhitespace && (char === '/' || char === '\\')) {
      return true
    }
  }
  return false
}

function hasInternalWhitespaceBeforeTrimmedEnd(text: string): boolean {
  const trimmed = text.trimEnd()
  return /\s/.test(trimmed)
}

function isAtTrimmedLineEnd(lineText: string, endIndex: number): boolean {
  return lineText.slice(endIndex).trim().length === 0
}

function hasSpacedPathExtension(text: string): boolean {
  const trimmedRange = trimSpacedPathTrailingProse({
    text,
    startIndex: 0,
    endIndex: text.length
  })
  const trimmedText = trimmedRange.text.trimEnd()
  return /\s/.test(trimmedText) && /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?$/.test(trimmedText)
}

// 裸单词由 provider 对照文件系统验证，因此该过滤器的任务是在支付 stat 成本之前
// 拒绝明显不是文件名的 Token。像 `src` 或 `my-cli` 这样的普通单词通常是目录或
// 二进制文件，产生的噪音大于价值——如果真的想打开它们，可以加上 `./` 前缀。
function looksLikeFilename(token: string): boolean {
  if (token.length < 2 || token.length > 100) {
    return false
  }
  if (!BARE_FILENAME_PATTERN.test(token)) {
    return false
  }
  if (/^\d+$/.test(token)) {
    return false
  }
  if (token.includes('.')) {
    return !/^\.+$/.test(token)
  }
  return EXTENSIONLESS_FILENAMES.has(token)
}

type DetectedRange = { startIndex: number; endIndex: number; text: string }
// 共享 Token 化：对行运行正则，裁剪边界标点，将每个幸存的区间交给调用者。
// 合并了该模块中已有的三个几乎相同的循环。
function* detectRanges(lineText: string, regex: RegExp): Generator<DetectedRange> {
  for (const match of lineText.matchAll(regex)) {
    const rawStart = match.index ?? 0
    const trimmed = trimBoundaryPunctuation(match[0], rawStart)
    if (trimmed) {
      yield trimmed
    }
  }
}

function getImmediateUriPrefix(lineText: string, endIndex: number): string {
  let start = endIndex
  while (start > 0 && URI_PREFIX_CHAR_PATTERN.test(lineText[start - 1])) {
    start -= 1
  }
  return lineText.slice(start, endIndex)
}

function isInsideUriScheme(lineText: string, range: DetectedRange): boolean {
  const prefix = getImmediateUriPrefix(lineText, range.startIndex)
  // 为什么：本地路径匹配可以从 URL 的 `//host/path` 部分开始。
  return (
    range.text.includes('://') ||
    (/[A-Za-z][A-Za-z0-9+.-]*:(?:\/\/)?$/.test(prefix) &&
      (prefix.endsWith('://') || range.text.startsWith('//')))
  )
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  if (ranges.length <= 1) {
    return ranges
  }
  const sorted = ranges.slice().sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged: [number, number][] = []
  for (const range of sorted) {
    const last = merged.at(-1)
    if (!last || range[0] > last[1]) {
      merged.push([range[0], range[1]])
      continue
    }
    last[1] = Math.max(last[1], range[1])
  }
  return merged
}

function rangesOverlap(range: DetectedRange, claimedRanges: readonly [number, number][]): boolean {
  // 为什么：生成的终端行可能包含数千个看起来像文件的 Token；
  // 重叠检查必须保持对数级别，而不是扫描每个先前的区间。
  let low = 0
  let high = claimedRanges.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (claimedRanges[mid][0] < range.endIndex) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  const previous = claimedRanges[low - 1]
  return previous !== undefined && previous[1] > range.startIndex
}

function insertClaimedRange(claimedRanges: [number, number][], range: [number, number]): void {
  const last = claimedRanges.at(-1)
  if (!last || last[0] <= range[0]) {
    claimedRanges.push(range)
    return
  }

  let low = 0
  let high = claimedRanges.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (claimedRanges[mid][0] <= range[0]) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  claimedRanges.splice(low, 0, range)
}

function trimSpacedPathTrailingProse(range: DetectedRange): DetectedRange {
  // 为什么：保留一个扩展名终止的路径，但丢弃广泛的空格路径扫描也捕获的
  // 尾部散文或第二个不相关的路径。行尾扩展名 Token 仅当添加的段是路径形式
  // （包含分隔符）时才扩展跨度——"v1.2 reports/result.json" 扩展，
  // 像 "failed to start app.py" 这样的散文不能被吞掉。
  let selected: string | null = null
  const extensionPrefixPattern = /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?(?=\s+|$)/g
  let match: RegExpExecArray | null
  while ((match = extensionPrefixPattern.exec(range.text)) !== null) {
    const end = match.index + match[0].length
    const text = range.text.slice(0, end)
    if (countPathStarts(text) > 1) {
      continue
    }
    if (
      end < range.text.length ||
      selected === null ||
      /[\\/]/.test(range.text.slice(selected.length, end))
    ) {
      selected = text
    }
  }
  if (!selected) {
    return range
  }
  return {
    text: selected,
    startIndex: range.startIndex,
    endIndex: range.startIndex + selected.length
  }
}

function countPathStarts(text: string): number {
  let count = 0
  for (const match of text.matchAll(/(?:^|\s)(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/g)) {
    void match
    count += 1
  }
  return count
}

function trimTrailingWhitespace(range: DetectedRange): DetectedRange {
  const text = range.text.trimEnd()
  return {
    text,
    startIndex: range.startIndex,
    endIndex: range.startIndex + text.length
  }
}

function buildLineEndingSpacedPathPrefixRanges(range: DetectedRange): DetectedRange[] {
  const ranges: DetectedRange[] = []
  for (const match of range.text.matchAll(/\s+/g)) {
    const endIndex = match.index ?? 0
    const text = range.text.slice(0, endIndex).trimEnd()
    if (text.includes(' ')) {
      ranges.push({
        text,
        startIndex: range.startIndex,
        endIndex: range.startIndex + text.length
      })
    }
  }
  return ranges.toReversed()
}

function toParsedLink(range: DetectedRange): ParsedTerminalFileLink | null {
  const parsed = parseExplicitFileLinkTarget(range.text)
  if (!parsed) {
    return null
  }
  return {
    pathText: parsed.pathText,
    line: parsed.line,
    column: parsed.column,
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    displayText: range.text
  }
}

function sortLinksByPosition(links: ParsedTerminalFileLink[]): ParsedTerminalFileLink[] {
  return links.sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex)
}

// 移植自 VSCode 的 TerminalLocalLinkDetector。提取任何包含路径分隔符的内容，
// 可选地带有 `:line:col` 后缀——覆盖 `./src/foo.ts`、`/abs/bar`、
// `src/foo.ts:12:3` 等。
function detectLocalPathLinks(
  lineText: string,
  includeLineEndingPrefixCandidates = false
): ParsedTerminalFileLink[] {
  if (!hasPathSeparator(lineText)) {
    return []
  }

  const links: ParsedTerminalFileLink[] = []
  const spacedLinks = detectSpacedLocalPathLinks(lineText, includeLineEndingPrefixCandidates)
  const spacedRanges = mergeRanges(
    spacedLinks.map(({ startIndex, endIndex }): [number, number] => [startIndex, endIndex])
  )
  for (const link of spacedLinks) {
    links.push(link)
  }
  for (const range of detectRanges(lineText, LOCAL_PATH_REGEX)) {
    if (rangesOverlap(range, spacedRanges)) {
      continue
    }
    if (isInsideUriScheme(lineText, range)) {
      continue
    }
    if (!/[\\/]/.test(range.text)) {
      continue
    }
    const link = toParsedLink(range)
    if (link) {
      links.push(link)
    }
  }
  return sortLinksByPosition(links)
}

function detectSpacedLocalPathLinks(
  lineText: string,
  includeLineEndingPrefixCandidates = false
): ParsedTerminalFileLink[] {
  const links: ParsedTerminalFileLink[] = []
  const claimedRanges: [number, number][] = []
  for (const regex of SPACED_LOCAL_PATH_REGEXES) {
    for (const range of detectRanges(lineText, regex)) {
      if (regex === SPACED_PATH_WITH_SEPARATOR_REGEX && !hasSeparatorAfterWhitespace(range.text)) {
        continue
      }
      if (regex === SPACED_PATH_WITH_EXTENSION_REGEX && !hasSpacedPathExtension(range.text)) {
        continue
      }
      if (
        regex === LINE_ENDING_SPACED_PATH_REGEX &&
        (!hasInternalWhitespaceBeforeTrimmedEnd(range.text) ||
          !isAtTrimmedLineEnd(lineText, range.endIndex))
      ) {
        continue
      }
      if (rangesOverlap(range, claimedRanges) || isInsideUriScheme(lineText, range)) {
        continue
      }
      const candidateRanges =
        includeLineEndingPrefixCandidates && regex === LINE_ENDING_SPACED_PATH_REGEX
          ? [range, ...buildLineEndingSpacedPathPrefixRanges(range)]
          : [range]
      const candidateLinks = candidateRanges
        .map((candidateRange) =>
          toParsedLink(trimSpacedPathTrailingProse(trimTrailingWhitespace(candidateRange)))
        )
        .filter((link): link is ParsedTerminalFileLink => link !== null)
      const link = candidateLinks[0]
      if (link) {
        for (const candidateLink of candidateLinks) {
          links.push(candidateLink)
        }
        insertClaimedRange(claimedRanges, [link.startIndex, link.endIndex])
      }
    }
  }
  return links
}

// 移植自 VSCode 的 TerminalWordLinkDetector。在分隔符上对行进行 Token 化，
// 并发出文件名似的单词，以便 `ls` 输出变得可点击。
// 跳过已被本地路径阶段声明的区间，以避免裸文件名恰好是较长路径子串时的双重链接。
function detectBareFilenameLinks(
  lineText: string,
  claimedRanges: readonly [number, number][]
): ParsedTerminalFileLink[] {
  const links: ParsedTerminalFileLink[] = []
  for (const range of detectRanges(lineText, WORD_TOKEN_REGEX)) {
    if (rangesOverlap(range, claimedRanges)) {
      continue
    }
    // 为什么：巨大的终端 blob 可能是一个不间断的 Token；
    // 只解析有界裸文件名候选，以便悬停链接检测保持交互响应。
    if (range.text.length > MAX_BARE_FILENAME_TOKEN_LENGTH) {
      continue
    }
    const link = toParsedLink(range)
    if (!link) {
      continue
    }
    if (!looksLikeFilename(link.pathText)) {
      continue
    }
    links.push(link)
  }
  return links
}

export function extractTerminalFileLinks(lineText: string): ParsedTerminalFileLink[] {
  const pathLinks = detectLocalPathLinks(lineText)
  const claimed = mergeRanges(
    pathLinks.map(({ startIndex, endIndex }): [number, number] => [startIndex, endIndex])
  )
  const wordLinks = detectBareFilenameLinks(lineText, claimed)
  for (const link of wordLinks) {
    pathLinks.push(link)
  }
  return pathLinks
}

export function extractTerminalFileLinkCandidates(lineText: string): ParsedTerminalFileLink[] {
  const pathLinks = detectLocalPathLinks(lineText, true)
  const claimed = mergeRanges(
    pathLinks.map(({ startIndex, endIndex }): [number, number] => [startIndex, endIndex])
  )
  const wordLinks = detectBareFilenameLinks(lineText, claimed)
  for (const link of wordLinks) {
    pathLinks.push(link)
  }
  return pathLinks
}

export function resolveTerminalFileLink(
  parsed: ParsedTerminalFileLink,
  cwd: string,
  homePath?: string | null
): ResolvedTerminalFileLink | null {
  return resolveExplicitFileLinkTarget(parsed, cwd, homePath)
}

export function resolveTerminalFileLinkText(
  linkText: string,
  cwd: string,
  homePath?: string | null
): ResolvedTerminalFileLink | null {
  const links = extractTerminalFileLinks(linkText)
  const exactLink = links.find((link) => link.startIndex === 0 && link.endIndex === linkText.length)
  return exactLink ? resolveTerminalFileLink(exactLink, cwd, homePath) : null
}

export function isPathInsideWorktree(filePath: string, worktreePath: string): boolean {
  const normalizedFile = normalizeAbsolutePath(filePath)
  const normalizedWorktree = normalizeAbsolutePath(worktreePath)
  if (
    !normalizedFile ||
    !normalizedWorktree ||
    normalizedFile.rootKind !== normalizedWorktree.rootKind
  ) {
    return false
  }
  if (normalizedFile.comparisonKey === normalizedWorktree.comparisonKey) {
    return true
  }
  return normalizedFile.comparisonKey.startsWith(`${normalizedWorktree.comparisonKey}/`)
}