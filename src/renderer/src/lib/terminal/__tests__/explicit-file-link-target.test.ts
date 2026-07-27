// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  parseExplicitFileLinkTarget,
  resolveExplicitFileLinkTarget,
  resolveExplicitFileLinkTargetPath
} from '../explicit-file-link-target'

describe('parseExplicitFileLinkTarget', () => {
  describe('基本解析', () => {
    it('解析纯路径（无行号列号）', () => {
      const result = parseExplicitFileLinkTarget('/home/user/file.ts')
      expect(result).toEqual({
        pathText: '/home/user/file.ts',
        line: null,
        column: null
      })
    })

    it('解析路径 + 行号', () => {
      const result = parseExplicitFileLinkTarget('/home/user/file.ts:42')
      expect(result).toEqual({
        pathText: '/home/user/file.ts',
        line: 42,
        column: null
      })
    })

    it('解析路径 + 行号 + 列号', () => {
      const result = parseExplicitFileLinkTarget('/home/user/file.ts:42:10')
      expect(result).toEqual({
        pathText: '/home/user/file.ts',
        line: 42,
        column: 10
      })
    })

    it('解析 Windows 路径', () => {
      const result = parseExplicitFileLinkTarget('C:/Users/user/file.ts:10:5')
      expect(result).toEqual({
        pathText: 'C:/Users/user/file.ts',
        line: 10,
        column: 5
      })
    })

    it('解析相对路径', () => {
      const result = parseExplicitFileLinkTarget('./src/file.ts:3')
      expect(result).toEqual({
        pathText: './src/file.ts',
        line: 3,
        column: null
      })
    })

    it('解析 ~ 开头路径', () => {
      const result = parseExplicitFileLinkTarget('~/project/file.ts:1:1')
      expect(result).toEqual({
        pathText: '~/project/file.ts',
        line: 1,
        column: 1
      })
    })
  })

  describe('边界情况', () => {
    it('空字符串返回 null', () => {
      expect(parseExplicitFileLinkTarget('')).toBeNull()
    })

    it('仅冒号时 pathText 为冒号本身（非 null）', () => {
      const result = parseExplicitFileLinkTarget(':')
      expect(result).toEqual({
        pathText: ':',
        line: null,
        column: null
      })
    })

    it('仅行号无路径返回 null', () => {
      expect(parseExplicitFileLinkTarget(':10')).toBeNull()
    })

    it('仅行号列号无路径返回 null', () => {
      expect(parseExplicitFileLinkTarget(':10:5')).toBeNull()
    })

    it('路径以斜杠后跟空格开头返回 null', () => {
      expect(parseExplicitFileLinkTarget('/  path/file.ts')).toBeNull()
    })

    it('行号为 0 返回 null（1-indexed）', () => {
      const result = parseExplicitFileLinkTarget('file.ts:0')
      expect(result).toBeNull()
    })

    it('列号为 0 返回 null（1-indexed）', () => {
      const result = parseExplicitFileLinkTarget('file.ts:1:0')
      expect(result).toBeNull()
    })

    it('负号不作为行号解析（-1 不匹配 \\d+，留在 pathText 中）', () => {
      const result = parseExplicitFileLinkTarget('file.ts:-1')
      expect(result).toEqual({
        pathText: 'file.ts:-1',
        line: null,
        column: null
      })
    })

    it('大量数字作为行号列号', () => {
      const result = parseExplicitFileLinkTarget('file.ts:99999:99999')
      expect(result).toEqual({
        pathText: 'file.ts',
        line: 99999,
        column: 99999
      })
    })
  })

  describe('路径中包含冒号', () => {
    it('Windows 驱动器号中的冒号不被视为分隔符', () => {
      const result = parseExplicitFileLinkTarget('C:/path/file.ts:42')
      expect(result).toEqual({
        pathText: 'C:/path/file.ts',
        line: 42,
        column: null
      })
    })

    it('多个冒号——仅最后两个数字被解析为行号列号', () => {
      const result = parseExplicitFileLinkTarget('label:value:10:5')
      expect(result).toEqual({
        pathText: 'label:value',
        line: 10,
        column: 5
      })
    })
  })

  describe('尾部斜杠处理', () => {
    it('绝对路径尾部斜杠默认允许保留', () => {
      const result = parseExplicitFileLinkTarget('/home/user/dir/')
      expect(result).toEqual({
        pathText: '/home/user/dir/',
        line: null,
        column: null
      })
    })

    it('裸根路径 "/" 尾部斜杠不允许保留', () => {
      expect(parseExplicitFileLinkTarget('/')).toBeNull()
    })

    it('裸根路径 "~/" 尾部斜杠不允许保留', () => {
      expect(parseExplicitFileLinkTarget('~/')).toBeNull()
    })

    it('裸 Windows 根路径 "C:/" 尾部斜杠不允许保留', () => {
      expect(parseExplicitFileLinkTarget('C:/')).toBeNull()
    })

    it('相对路径尾部斜杠默认不允许保留', () => {
      expect(parseExplicitFileLinkTarget('relative/dir/')).toBeNull()
    })

    it('相对路径尾部斜杠 + allowRelativeDirectoryPath 允许保留', () => {
      const result = parseExplicitFileLinkTarget('relative/dir/', {
        allowRelativeDirectoryPath: true
      })
      expect(result).toEqual({
        pathText: 'relative/dir/',
        line: null,
        column: null
      })
    })

    it('绝对路径尾部斜杠 + 行号时不允许保留', () => {
      expect(parseExplicitFileLinkTarget('/home/user/dir/:42')).toBeNull()
    })

    it('反斜杠作为路径分隔符', () => {
      const result = parseExplicitFileLinkTarget('C:\\Users\\user\\file.ts:10')
      expect(result).toEqual({
        pathText: 'C:\\Users\\user\\file.ts',
        line: 10,
        column: null
      })
    })
  })
})

describe('resolveExplicitFileLinkTargetPath', () => {
  it('绝对路径被规范化', () => {
    const result = resolveExplicitFileLinkTargetPath(
      '/home/user/../user/file.ts',
      '/home/user'
    )
    expect(result).toBe('/home/user/file.ts')
  })

  it('Windows 绝对路径被规范化', () => {
    const result = resolveExplicitFileLinkTargetPath(
      'C:/Users/../Users/user/file.ts',
      'C:/Users/user'
    )
    expect(result).toBe('C:/Users/user/file.ts')
  })

  it('相对路径拼接到 cwd', () => {
    const result = resolveExplicitFileLinkTargetPath(
      'src/file.ts',
      '/home/user/project'
    )
    expect(result).toBe('/home/user/project/src/file.ts')
  })

  it('相对路径含 .. 正确弹出基路径的段', () => {
    const result = resolveExplicitFileLinkTargetPath(
      '../other/file.ts',
      '/home/user/project'
    )
    // normalizeJoinedPath 将基路径与相对路径合并后一起归一化，
    // 使得 .. 可以正确弹出基路径的「project」段。
    expect(result).toBe('/home/user/other/file.ts')
  })

  it('~ 开头路径使用 homePath 展开', () => {
    const result = resolveExplicitFileLinkTargetPath(
      '~/project/file.ts',
      '/home/user',
      '/home/user'
    )
    expect(result).toBe('/home/user/project/file.ts')
  })

  it('~ 开头路径无 homePath 时从 cwd 推断', () => {
    const result = resolveExplicitFileLinkTargetPath(
      '~/project/file.ts',
      '/home/user'
    )
    expect(result).toBe('/home/user/project/file.ts')
  })

  it('Windows 下 ~ 开头路径从 cwd 推断', () => {
    const result = resolveExplicitFileLinkTargetPath(
      '~/project/file.ts',
      'C:/Users/user'
    )
    expect(result).toBe('C:/Users/user/project/file.ts')
  })
})

describe('resolveExplicitFileLinkTarget', () => {
  it('解析 Parsed 并返回绝对路径 + 行列号', () => {
    const parsed = parseExplicitFileLinkTarget('/home/user/file.ts:42:10')!
    const result = resolveExplicitFileLinkTarget(parsed, '/home/user')
    expect(result).toEqual({
      absolutePath: '/home/user/file.ts',
      line: 42,
      column: 10
    })
  })

  it('返回 Parsed 中的行列号', () => {
    const parsed = { pathText: '/file.ts', line: 5, column: 3 }
    const result = resolveExplicitFileLinkTarget(parsed, '/home')
    expect(result).toEqual({
      absolutePath: '/file.ts',
      line: 5,
      column: 3
    })
  })

  it('行列号为 null 时透传', () => {
    const parsed = { pathText: '/file.ts', line: null, column: null }
    const result = resolveExplicitFileLinkTarget(parsed, '/home')
    expect(result).toEqual({
      absolutePath: '/file.ts',
      line: null,
      column: null
    })
  })

  it('空路径文本会拼接 cwd 得到结果（非 null）', () => {
    const parsed = { pathText: '', line: null, column: null }
    const result = resolveExplicitFileLinkTarget(parsed, '/home')
    // 空路径被 joinAbsolutePath 拼接到 cwd 上返回 /home
    expect(result).toEqual({
      absolutePath: '/home',
      line: null,
      column: null
    })
  })

  it('相对路径解析', () => {
    const parsed = parseExplicitFileLinkTarget('src/file.ts:10')!
    const result = resolveExplicitFileLinkTarget(parsed, '/home/user/project')
    expect(result).toEqual({
      absolutePath: '/home/user/project/src/file.ts',
      line: 10,
      column: null
    })
  })

  it('~ 路径解析', () => {
    const parsed = parseExplicitFileLinkTarget('~/config/file.ts:1:1')!
    const result = resolveExplicitFileLinkTarget(
      parsed,
      '/home/user',
      '/home/user'
    )
    expect(result).toEqual({
      absolutePath: '/home/user/config/file.ts',
      line: 1,
      column: 1
    })
  })
})