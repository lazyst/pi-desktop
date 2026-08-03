import { describe, expect, it } from 'vitest'
import {
  analyzeRawTitle,
  extractAllOscTitles,
  extractLastOscTitle
} from '../osc-title-extractor'

// ESC = \x1b；BEL = \x07；ST = ESC \（\x1b\\）
const OSC = (title: string): string => `\x1b]0;${title}\x07`

// ---------------------------------------------------------------------------
// extractAllOscTitles
// ---------------------------------------------------------------------------

describe('extractAllOscTitles', () => {
  it('单个标题', () => {
    expect(extractAllOscTitles(OSC('⠋ π - cwd'))).toEqual(['⠋ π - cwd'])
  })

  it('合并的 data chunk（三个标题，中间有文本）', () => {
    const data = `${OSC('⠋ π - cwd')}some output${OSC('⠙ π - cwd')}more${OSC('π - cwd')}`
    expect(extractAllOscTitles(data)).toEqual(['⠋ π - cwd', '⠙ π - cwd', 'π - cwd'])
  })

  it('连续标题，之间无文本', () => {
    const data = `${OSC('⠋ π - a')}${OSC('⠙ π - a')}${OSC('π - a')}`
    expect(extractAllOscTitles(data)).toEqual(['⠋ π - a', '⠙ π - a', 'π - a'])
  })

  it('纯文本无 OSC → []', () => {
    expect(extractAllOscTitles('hello world')).toEqual([])
  })

  it('空字符串 → []', () => {
    expect(extractAllOscTitles('')).toEqual([])
  })

  it('不完整 OSC 序列（缺少终止符）→ []', () => {
    expect(extractAllOscTitles('\x1b]0;π - cwd')).toEqual([])
  })

  it('穿插文本的通用标题', () => {
    const data = `start ${OSC('title1')} middle ${OSC('title2')} end`
    expect(extractAllOscTitles(data)).toEqual(['title1', 'title2'])
  })

  it('含 Unicode/emoji', () => {
    expect(extractAllOscTitles(OSC('π - 🚀 project'))).toEqual(['π - 🚀 project'])
  })

  it('空标题 \x1b]0;\x07 → [""]', () => {
    expect(extractAllOscTitles('\x1b]0;\x07')).toEqual([''])
  })

  it('无 Braille 的标题', () => {
    const data = `${OSC('working')}${OSC('idle')}`
    expect(extractAllOscTitles(data)).toEqual(['working', 'idle'])
  })

  it('ST 终止符 \x1b]0;π - a\x1b\\\\ → ["π - a"]', () => {
    expect(extractAllOscTitles('\x1b]0;π - a\x1b\\')).toEqual(['π - a'])
  })
})

// ---------------------------------------------------------------------------
// extractLastOscTitle
// ---------------------------------------------------------------------------

describe('extractLastOscTitle', () => {
  it('多个标题 → 最后一个', () => {
    const data = `${OSC('first')}${OSC('second')}`
    expect(extractLastOscTitle(data)).toBe('second')
  })

  it('单个标题 → 该标题', () => {
    expect(extractLastOscTitle(OSC('π - cwd'))).toBe('π - cwd')
  })

  it('无标题 → null', () => {
    expect(extractLastOscTitle('plain text')).toBeNull()
  })

  it('空字符串 → null', () => {
    expect(extractLastOscTitle('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// normalizeTerminalTitle（通过 analyzeRawTitle 间接验证）
// ---------------------------------------------------------------------------

describe('normalizeTerminalTitle (via analyzeRawTitle)', () => {
  it('移除前导 Braille 及其后空格', () => {
    expect(analyzeRawTitle('⠋ π - my-project').normalized).toBe('π - my-project')
  })

  it('无 Braille 前缀不变', () => {
    expect(analyzeRawTitle('π - my-project').normalized).toBe('π - my-project')
  })

  it('前后空白 + Braille', () => {
    expect(analyzeRawTitle('  ⠙ π - foo  ').normalized).toBe('π - foo')
  })

  it('仅 Braille → 空字符串', () => {
    expect(analyzeRawTitle('⠋').normalized).toBe('')
  })

  it('多个 Braille 字符', () => {
    expect(analyzeRawTitle('⠋⠙⠹ π - x').normalized).toBe('π - x')
  })

  it('纯文本仅去空白', () => {
    expect(analyzeRawTitle('  hello  ').normalized).toBe('hello')
  })

  it('空字符串 → 空字符串', () => {
    expect(analyzeRawTitle('').normalized).toBe('')
  })

  it('Braille 后无空格', () => {
    expect(analyzeRawTitle('⠋π - x').normalized).toBe('π - x')
  })

  it('中文内容保留', () => {
    expect(analyzeRawTitle('π - 会话名').normalized).toBe('π - 会话名')
  })
})

// ---------------------------------------------------------------------------
// analyzeRawTitle
// ---------------------------------------------------------------------------

describe('analyzeRawTitle', () => {
  it('Braille 前缀 → working', () => {
    expect(analyzeRawTitle('⠋ π - project')).toEqual({
      normalized: 'π - project',
      status: 'working'
    })
  })

  it('无 Braille 前缀 → idle', () => {
    expect(analyzeRawTitle('π - project')).toEqual({
      normalized: 'π - project',
      status: 'idle'
    })
  })

  it('仅 Braille → working 且 normalized 为空', () => {
    expect(analyzeRawTitle('⠙')).toEqual({ normalized: '', status: 'working' })
  })

  it('空字符串 → null', () => {
    expect(analyzeRawTitle('')).toEqual({ normalized: '', status: null })
  })

  it('前导空白 + Braille → working', () => {
    expect(analyzeRawTitle('  ⠋  π - x')).toEqual({ normalized: 'π - x', status: 'working' })
  })

  it('前导空白 + 无 Braille → idle', () => {
    expect(analyzeRawTitle('  π - x')).toEqual({ normalized: 'π - x', status: 'idle' })
  })
})
