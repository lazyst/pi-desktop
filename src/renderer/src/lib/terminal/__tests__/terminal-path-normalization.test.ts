// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  inferHomePathFromCwd,
  joinAbsolutePath,
  normalizeAbsolutePath,
  resolveTildePath
} from '../terminal-path-normalization'

// ---------------------------------------------------------------------------
// normalizeAbsolutePath
// ---------------------------------------------------------------------------

describe('normalizeAbsolutePath', () => {
  describe('POSIX 路径', () => {
    it('平凡的根路径', () => {
      expect(normalizeAbsolutePath('/')).toMatchObject({
        normalized: '/',
        comparisonKey: '/',
        rootKind: 'posix'
      })
    })

    it('简单路径', () => {
      expect(normalizeAbsolutePath('/home/user')).toMatchObject({
        normalized: '/home/user',
        comparisonKey: '/home/user',
        rootKind: 'posix'
      })
    })

    it('末尾斜杠', () => {
      expect(normalizeAbsolutePath('/home/user/')).toMatchObject({
        normalized: '/home/user',
        rootKind: 'posix'
      })
    })

    it('解析 .. 片段', () => {
      expect(normalizeAbsolutePath('/home/user/../docs')).toMatchObject({
        normalized: '/home/docs',
        rootKind: 'posix'
      })
    })

    it('解析 . 片段', () => {
      expect(normalizeAbsolutePath('/home/./user')).toMatchObject({
        normalized: '/home/user',
        rootKind: 'posix'
      })
    })

    it('`..` 超出根目录时停留在根目录', () => {
      expect(normalizeAbsolutePath('/../../..')).toMatchObject({
        normalized: '/',
        rootKind: 'posix'
      })
    })

    it('连续斜杠被折叠', () => {
      expect(normalizeAbsolutePath('/home///user//docs')).toMatchObject({
        normalized: '/home/user/docs',
        rootKind: 'posix'
      })
    })
  })

  describe('Windows 盘符路径', () => {
    it('盘符 + 反斜杠', () => {
      const result = normalizeAbsolutePath('C:\\Users\\test')
      expect(result).not.toBeNull()
      expect(result!.normalized).toBe('C:/Users/test')
      expect(result!.comparisonKey).toBe('c:/users/test')
      expect(result!.rootKind).toBe('windows')
    })

    it('盘符 + 正斜杠', () => {
      expect(normalizeAbsolutePath('C:/Users/test')).toMatchObject({
        normalized: 'C:/Users/test',
        rootKind: 'windows'
      })
    })

    it('盘符 + 根路径', () => {
      expect(normalizeAbsolutePath('D:\\')).toMatchObject({
        normalized: 'D:/',
        rootKind: 'windows'
      })
    })

    it('仅盘符无后缀', () => {
      expect(normalizeAbsolutePath('E:')).toMatchObject({
        normalized: 'E:/',
        rootKind: 'windows'
      })
    })

    it('小写盘符转为大写', () => {
      const result = normalizeAbsolutePath('c:\\windows\\system32')
      expect(result).not.toBeNull()
      expect(result!.normalized).toBe('C:/windows/system32')
      expect(result!.comparisonKey).toBe('c:/windows/system32')
    })

    it('解析 .. 片段', () => {
      expect(normalizeAbsolutePath('C:\\Users\\test\\..\\Public')).toMatchObject({
        normalized: 'C:/Users/Public',
        rootKind: 'windows'
      })
    })
  })

  describe('UNC 路径', () => {
    it('双反斜杠 UNC', () => {
      const result = normalizeAbsolutePath('\\\\server\\share\\folder')
      expect(result).not.toBeNull()
      expect(result!.normalized).toBe('//server/share/folder')
      expect(result!.comparisonKey).toBe('//server/share/folder')
      expect(result!.rootKind).toBe('unc')
    })

    it('双正斜杠 UNC', () => {
      expect(normalizeAbsolutePath('//server/share/folder')).toMatchObject({
        normalized: '//server/share/folder',
        rootKind: 'unc'
      })
    })

    it('UNC 根路径（无子目录）', () => {
      expect(normalizeAbsolutePath('\\\\server\\share')).toMatchObject({
        normalized: '//server/share',
        rootKind: 'unc'
      })
    })

    it('解析 .. 片段', () => {
      expect(normalizeAbsolutePath('\\\\server\\share\\folder1\\..\\folder2')).toMatchObject({
        normalized: '//server/share/folder2',
        rootKind: 'unc'
      })
    })

    it('server 或 share 中带点', () => {
      expect(normalizeAbsolutePath('//my-server.local/share_dir/file')).toMatchObject({
        normalized: '//my-server.local/share_dir/file',
        rootKind: 'unc'
      })
    })

    it('双正斜杠前缀视为 UNC（即使 server 部分是常见主机名）', () => {
      // 注意：POSIX 允许实现定义 // 前缀的行为，本模块选择将其作为 UNC 处理
      expect(normalizeAbsolutePath('//home/user')).toMatchObject({
        normalized: '//home/user',
        rootKind: 'unc'
      })
    })
  })

  describe('非绝对路径', () => {
    it('相对路径返回 null', () => {
      expect(normalizeAbsolutePath('relative/path')).toBeNull()
    })

    it('相对路径带点', () => {
      expect(normalizeAbsolutePath('./relative')).toBeNull()
    })

    it('仅盘符无冒号', () => {
      expect(normalizeAbsolutePath('C')).toBeNull()
    })

    it('空字符串', () => {
      expect(normalizeAbsolutePath('')).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// inferHomePathFromCwd
// ---------------------------------------------------------------------------

describe('inferHomePathFromCwd', () => {
  describe('Windows cwd', () => {
    it('从 C:/Users/<username> 推断 home', () => {
      expect(inferHomePathFromCwd('C:\\Users\\john')).toBe('C:/Users/john')
    })

    it('从 C:/Users/<username>/subdir 推断 home', () => {
      expect(inferHomePathFromCwd('C:/Users/john/Documents')).toBe('C:/Users/john')
    })

    it('users 不区分大小写', () => {
      expect(inferHomePathFromCwd('C:\\USERS\\john')).toBe('C:/USERS/john')
    })

    it('非 Users 路径返回 null', () => {
      expect(inferHomePathFromCwd('C:\\Program Files')).toBeNull()
    })

    it('Users 段缺少用户名返回 null', () => {
      expect(inferHomePathFromCwd('C:\\Users')).toBeNull()
    })
  })

  describe('POSIX cwd', () => {
    it('从 /home/<username> 推断 home', () => {
      expect(inferHomePathFromCwd('/home/alice')).toBe('/home/alice')
    })

    it('从 /home/<username>/subdir 推断 home', () => {
      expect(inferHomePathFromCwd('/home/alice/projects')).toBe('/home/alice')
    })

    it('从 /Users/<username> 推断 home（macOS）', () => {
      expect(inferHomePathFromCwd('/Users/bob')).toBe('/Users/bob')
    })

    it('/root 返回 /root', () => {
      expect(inferHomePathFromCwd('/root')).toBe('/root')
    })

    it('/root/subdir 返回 /root', () => {
      expect(inferHomePathFromCwd('/root/.ssh')).toBe('/root')
    })

    it('非标准路径返回 null', () => {
      expect(inferHomePathFromCwd('/var/www')).toBeNull()
    })
  })

  describe('其他', () => {
    it('UNC 路径返回 null', () => {
      expect(inferHomePathFromCwd('\\\\server\\share')).toBeNull()
    })

    it('相对路径返回 null', () => {
      expect(inferHomePathFromCwd('relative/path')).toBeNull()
    })

    it('空字符串返回 null', () => {
      expect(inferHomePathFromCwd('')).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// resolveTildePath
// ---------------------------------------------------------------------------

describe('resolveTildePath', () => {
  it('展开 ~/docs 到 Windows home', () => {
    expect(resolveTildePath('~/docs', 'C:\\Users\\john')).toBe('C:/Users/john/docs')
  })

  it('展开 ~/docs 到 POSIX home', () => {
    expect(resolveTildePath('~/docs', '/home/alice')).toBe('/home/alice/docs')
  })

  it('展开 ~/docs 到 /root', () => {
    expect(resolveTildePath('~/docs', '/root')).toBe('/root/docs')
  })

  it('展开 ~/docs 到 macOS home', () => {
    expect(resolveTildePath('~/docs', '/Users/bob')).toBe('/Users/bob/docs')
  })

  it('优先使用显式 homePath', () => {
    // cwd 指向 /var/www，但显式传入 homePath
    expect(resolveTildePath('~/project', '/var/www', '/home/alice')).toBe('/home/alice/project')
  })

  it('homePath 为空白字符串时回退到 cwd 推断', () => {
    expect(resolveTildePath('~/docs', '/home/alice', '')).toBe('/home/alice/docs')
  })

  it('不以 ~ 开头的路径返回 null', () => {
    expect(resolveTildePath('/absolute/path', '/home/user')).toBeNull()
  })

  it('仅 ~ 不跟斜杠的路径返回 null', () => {
    expect(resolveTildePath('~foo', '/home/user')).toBeNull()
  })

  it('无法推断 home 时返回 null', () => {
    expect(resolveTildePath('~/docs', '/var/www')).toBeNull()
  })

  it('展开 ~/ 带 .. 解析', () => {
    expect(resolveTildePath('~/a/../b', '/home/user')).toBe('/home/user/b')
  })

  it('UNC cwd 无法推断 home 时返回 null', () => {
    expect(resolveTildePath('~/docs', '//server/share')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// joinAbsolutePath
// ---------------------------------------------------------------------------

describe('joinAbsolutePath', () => {
  describe('POSIX base', () => {
    it('拼接简单路径', () => {
      expect(joinAbsolutePath('/home/user', 'docs')).toBe('/home/user/docs')
    })

    it('相对路径带 ..', () => {
      expect(joinAbsolutePath('/home/user', '../docs')).toBe('/home/docs')
    })

    it('相对路径带 .', () => {
      expect(joinAbsolutePath('/home/user', './docs')).toBe('/home/user/docs')
    })

    it('相对路径跨越多层', () => {
      expect(joinAbsolutePath('/a/b/c', '../../d')).toBe('/a/d')
    })

    it('base 为根目录', () => {
      expect(joinAbsolutePath('/', 'usr/bin')).toBe('/usr/bin')
    })
  })

  describe('Windows base', () => {
    it('拼接简单路径', () => {
      expect(joinAbsolutePath('C:\\Users', 'test')).toBe('C:/Users/test')
    })

    it('相对路径带 ..', () => {
      expect(joinAbsolutePath('C:\\Users\\test', '..\\Public')).toBe('C:/Users/Public')
    })

    it('base 为根目录', () => {
      expect(joinAbsolutePath('D:\\', 'data')).toBe('D:/data')
    })
  })

  describe('UNC base', () => {
    it('拼接简单路径', () => {
      expect(joinAbsolutePath('\\\\server\\share', 'folder')).toBe('//server/share/folder')
    })

    it('相对路径带 ..', () => {
      expect(joinAbsolutePath('\\\\server\\share\\a', '..\\b')).toBe('//server/share/b')
    })
  })

  describe('非绝对路径 base', () => {
    it('相对路径 base 返回 null', () => {
      expect(joinAbsolutePath('relative/path', 'file')).toBeNull()
    })

    it('空字符串 base 返回 null', () => {
      expect(joinAbsolutePath('', 'file')).toBeNull()
    })
  })
})