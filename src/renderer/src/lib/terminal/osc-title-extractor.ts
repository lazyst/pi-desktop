/** OSC 0 标题序列提取与标准化 —— 纯函数工具模块。
 *
 * 终端通过 OSC 0 序列（`ESC ] 0 ; <title> BEL|ST`）设置窗口标题。
 * 本模块负责从原始数据字符串中提取这些标题、移除 pi 扩展 spinner
 * 使用的 Braille 前缀，并据此判定代理当前状态（working / idle）。
 *
 * ## 跨块限制
 *
 * 本模块只提取**单块内完整**的 OSC 序列，不处理跨块拆分
 * （例如标题序列被 TCP 分块拆成两段到达）。跨块场景应由 xterm 的
 * 有状态 parser（`onTitleChange`）处理，本模块不维护任何状态。
 *
 * 所有函数均为纯函数：无副作用，不依赖 xterm 或 Electron。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 单块内完整 OSC 0 序列：`ESC ] 0 ; <title> (BEL | ESC \)`。
 *
 * - `\x1b`：ESC
 * - `\]0;`：OSC 参数 0（窗口标题）分隔符
 * - `[^\x07\x1b\x9c]*`：标题内容，排除 BEL（\x07）、ESC（\x1b）、
 *   ST 单字节形式（\x9c）；用 `*` 允许空标题
 * - `(?:\x07|\x1b\\)`：终止符，BEL 或 ST（`ESC \`）二选一
 *
 * 使用 `g` 标志循环提取；每次调用循环都会扫描至无匹配，
 * `exec` 返回 null 时 `lastIndex` 自动归零，因此模块级复用安全。
 */
const OSC_TITLE_RE = /\x1b\]0;([^\x07\x1b\x9c]*)(?:\x07|\x1b\\)/g

/** Braille 字符范围（U+2800–U+28FF），pi 扩展 spinner 帧的字符集。 */
const BRAILLE_RE = /^[\u2800-\u28FF]/

/** 前导 Braille 字符及其后空白：`⠋ π - x` → 去掉 `⠋ ` 前缀。 */
const BRAILLE_PREFIX_WITH_SPACE_RE = /^[\u2800-\u28FF]+\s*/

// ---------------------------------------------------------------------------
// 提取
// ---------------------------------------------------------------------------

/** 从数据字符串中提取所有 OSC 0 标题。
 *
 * 仅提取单块内完整序列，不处理跨块拆分（跨块由 xterm 有状态 parser 处理）。
 * 支持 BEL（`\x07`）和 ST（`ESC \`）两种终止符。
 *
 * @param data 原始数据字符串（可能混有普通输出文本）
 * @returns 按出现顺序排列的标题列表；无完整序列时返回空数组
 */
export function extractAllOscTitles(data: string): string[] {
  const titles: string[] = []
  OSC_TITLE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = OSC_TITLE_RE.exec(data)) !== null) {
    titles.push(match[1])
  }

  return titles
}

/** 从数据字符串中提取最后一个 OSC 0 标题。
 *
 * @param data 原始数据字符串
 * @returns 最后一个标题；无完整序列时返回 null
 */
export function extractLastOscTitle(data: string): string | null {
  const titles = extractAllOscTitles(data)
  return titles.length > 0 ? titles[titles.length - 1] : null
}

// ---------------------------------------------------------------------------
// 标准化与状态判定
// ---------------------------------------------------------------------------

/** 标准化终端标题：移除前导 Braille 字符及其后空格，去除首尾空白。
 *
 * 内部函数，不对外导出。标准化后的标题不应被直接用于状态判定——
 * Braille 信息已丢失，无法分辨 working/idle。请使用 analyzeRawTitle() 统一入口。
 *
 * 示例：
 * - `"⠋ π - my-project"` → `"π - my-project"`
 * - `"π - my-project"`    → `"π - my-project"`
 *
 * @param title 原始标题
 * @returns 标准化后的标题（可能为空字符串）
 */
function normalizeTerminalTitle(title: string): string {
  return title.trim().replace(BRAILLE_PREFIX_WITH_SPACE_RE, '').trim()
}

/** 分析原始终端标题，返回标准化后的标题和代理状态。
 *
 * 统一入口：内部先检测 Braille 再标准化，从结构上杜绝传入
 * 已标准化标题导致 working 状态永远检测不到的问题。
 *
 * 状态判定：
 * - `working`：原始标题（去除首尾空白后）以 Braille 字符（U+2800–U+28FF）开头
 * - `idle`：无 Braille 前缀且非空（含 `"π - "` 前缀或其他 shell 标题）
 * - `null`：空字符串（或仅空白）
 *
 * @param raw 原始终端标题（未标准化）
 * @returns 标准化后的标题与代理状态
 */
export function analyzeRawTitle(raw: string): {
  normalized: string
  status: 'working' | 'idle' | null
} {
  const normalized = normalizeTerminalTitle(raw)
  if (BRAILLE_RE.test(raw.trim())) {
    return { normalized, status: 'working' }
  }

  // 无 Braille 前缀：非空视为 idle，仅空白视为 null。
  const status = raw.trim() === '' ? null : 'idle'
  return { normalized, status }
}
