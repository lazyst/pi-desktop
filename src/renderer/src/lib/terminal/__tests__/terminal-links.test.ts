// @vitest-environment jsdom
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import {
  extractTerminalFileLinks,
  isPathInsideWorktree,
  resolveTerminalFileLink,
  resolveTerminalFileLinkText
} from '../terminal-links'

// ─── 内联的 conformance 测试用例（移植自 orca shared/terminal-file-link-conformance） ─────

type TerminalFileLinkTapExpectation = {
  pathText: string
  line: number | null
  column: number | null
}

type TerminalFileLinkTapConformanceCase = {
  name: string
  lineText: string
  tapText: string
  expected: TerminalFileLinkTapExpectation | null
}

function columnForTerminalFileLinkTap(testCase: TerminalFileLinkTapConformanceCase): number {
  const column = testCase.lineText.indexOf(testCase.tapText)
  if (column < 0) {
    throw new Error(`Tap text "${testCase.tapText}" not found in "${testCase.lineText}"`)
  }
  return column
}

const TERMINAL_FILE_LINK_TAP_CONFORMANCE_CASES: TerminalFileLinkTapConformanceCase[] = [
  {
    name: 'absolute path',
    lineText: 'created /tmp/out/report.html for you',
    tapText: 'report',
    expected: { pathText: '/tmp/out/report.html', line: null, column: null }
  },
  {
    name: 'relative path with line and column',
    lineText: 'see src/components/Button.tsx:12:7 here',
    tapText: 'Button',
    expected: { pathText: 'src/components/Button.tsx', line: 12, column: 7 }
  },
  {
    name: 'tilde path',
    lineText: 'wrote ~/Documents/notes.md',
    tapText: 'notes',
    expected: { pathText: '~/Documents/notes.md', line: null, column: null }
  },
  {
    name: 'directory segment containing a space',
    lineText: '/Users/me/My Project/readme.md done',
    tapText: 'readme',
    expected: { pathText: '/Users/me/My Project/readme.md', line: null, column: null }
  },
  {
    name: 'spaced path with line and column',
    lineText: 'wrote /tmp/orca report/result.json:12:3 for you',
    tapText: 'result',
    expected: { pathText: '/tmp/orca report/result.json', line: 12, column: 3 }
  },
  {
    name: 'spaced path with dotted directory',
    lineText: 'wrote /tmp/v1.2 reports/result.json for you',
    tapText: 'v1.2',
    expected: { pathText: '/tmp/v1.2 reports/result.json', line: null, column: null }
  },
  {
    name: 'spaced path with dotted directory at line end',
    lineText: 'wrote /tmp/v1.2 reports/result.json',
    tapText: 'result',
    expected: { pathText: '/tmp/v1.2 reports/result.json', line: null, column: null }
  },
  {
    name: 'spaced path at line end',
    lineText: 'wrote /tmp/final report.json',
    tapText: 'report',
    expected: { pathText: '/tmp/final report.json', line: null, column: null }
  },
  {
    name: 'path followed by prose ending in a filename',
    lineText: '/var/log/app.log failed to start app.py',
    tapText: 'app.log',
    expected: { pathText: '/var/log/app.log', line: null, column: null }
  },
  {
    name: 'trailing prose filename stays its own tap target',
    lineText: '/var/log/app.log failed to start app.py',
    tapText: 'app.py',
    expected: { pathText: 'app.py', line: null, column: null }
  },
  {
    name: 'relative path followed by prose ending in a filename',
    lineText: 'src/main.ts uses config.yaml',
    tapText: 'main',
    expected: { pathText: 'src/main.ts', line: null, column: null }
  },
  {
    name: 'spaced filename',
    lineText: 'wrote /tmp/final report.json for you',
    tapText: 'report',
    expected: { pathText: '/tmp/final report.json', line: null, column: null }
  },
  {
    name: 'spaced path ending in a dotfile',
    lineText: 'wrote /tmp/My Project/.env for you',
    tapText: '.env',
    expected: { pathText: '/tmp/My Project/.env', line: null, column: null }
  },
  {
    name: 'first of two spaced candidates',
    lineText: 'see /tmp/a.txt and /tmp/b.txt done',
    tapText: 'a.txt',
    expected: { pathText: '/tmp/a.txt', line: null, column: null }
  },
  {
    name: 'second of two spaced candidates',
    lineText: 'see /tmp/a.txt and /tmp/b.txt done',
    tapText: 'b.txt',
    expected: { pathText: '/tmp/b.txt', line: null, column: null }
  },
  {
    name: 'surrounding punctuation',
    lineText: 'open (src/a.ts) now',
    tapText: 'a.ts',
    expected: { pathText: 'src/a.ts', line: null, column: null }
  },
  {
    name: 'bare filename with extension',
    lineText: 'Here you go: README.md',
    tapText: 'README',
    expected: { pathText: 'README.md', line: null, column: null }
  },
  {
    name: 'plain prose word',
    lineText: 'just some prose with no path here',
    tapText: 'prose',
    expected: null
  }
]

function extractTerminalFileLinkAtColumn(lineText: string, column: number) {
  return (
    extractTerminalFileLinks(lineText).find(
      (link) => column >= link.startIndex && column < link.endIndex
    ) ?? null
  )
}

describe('terminal path helpers', () => {
  describe('shared terminal file-link tap conformance', () => {
    it.each(TERMINAL_FILE_LINK_TAP_CONFORMANCE_CASES)('$name', (testCase) => {
      const link = extractTerminalFileLinkAtColumn(
        testCase.lineText,
        columnForTerminalFileLinkTap(testCase)
      )
      expect(
        link ? { pathText: link.pathText, line: link.line, column: link.column } : null
      ).toEqual(testCase.expected)
    })
  })

  it('keeps worktree-relative paths on Windows external files', () => {
    expect(isPathInsideWorktree('C:\\repo\\src\\file.ts', 'C:\\repo')).toBe(true)
  })

  it('keeps worktree-relative paths for forward-slash Windows UNC paths', () => {
    expect(isPathInsideWorktree('//server/share/repo/src/file.ts', '\\\\server\\share\\repo')).toBe(
      true
    )
    expect(isPathInsideWorktree('//server/share/repo/src/file.ts', '//Server/Share/Repo')).toBe(
      true
    )
  })

  describe('extractTerminalFileLinks bare-filename tokens', () => {
    it('does not treat regular URL hosts as local file paths', () => {
      expect(
        extractTerminalFileLinks(
          'PR opened: https://github.com/stablyai/orca-marketing-website/pull/82'
        )
      ).toEqual([])
    })

    it('emits tentative link candidates for each token in ls-style output', () => {
      const line = 'CLAUDE.md    package.json    pnpm-lock.yaml    README.md'
      const links = extractTerminalFileLinks(line)
      const texts = links.map((link) => link.displayText)
      expect(texts).toEqual(['CLAUDE.md', 'package.json', 'pnpm-lock.yaml', 'README.md'])
      const claudeMd = links[0]
      expect(line.slice(claudeMd.startIndex, claudeMd.endIndex)).toBe('CLAUDE.md')
    })

    it('recognises common extensionless project files (Makefile, LICENSE, …)', () => {
      const links = extractTerminalFileLinks('Makefile LICENSE README Dockerfile src tests')
      expect(links.map((link) => link.displayText).sort()).toEqual([
        'Dockerfile',
        'LICENSE',
        'Makefile',
        'README'
      ])
    })

    it('ignores pure numbers, flag-looking tokens, and dotfile-only strings', () => {
      expect(extractTerminalFileLinks('42 100 .. . -v --verbose src dist')).toEqual([])
    })

    it('still strips trailing punctuation from bare filenames', () => {
      const links = extractTerminalFileLinks('See package.json, pnpm-lock.yaml.')
      expect(links.map((link) => link.displayText)).toEqual(['package.json', 'pnpm-lock.yaml'])
    })

    it('does not double-link bare tokens that are part of an already-matched path', () => {
      const links = extractTerminalFileLinks('./src/file.ts is the entry point')
      expect(links.map((link) => link.displayText)).toEqual(['./src/file.ts'])
    })

    it('carries line:column suffix on bare filenames (e.g. stack-trace output)', () => {
      const links = extractTerminalFileLinks('foo.ts:12:3 failed')
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({ pathText: 'foo.ts', line: 12, column: 3 })
    })

    it('keeps huge no-separator terminal tokens off the hover hot path', () => {
      const line = `${'b'.repeat(80 * 500)} package.json`
      const startedAt = performance.now()

      const links = extractTerminalFileLinks(line)

      expect(performance.now() - startedAt).toBeLessThan(100)
      expect(links.map((link) => link.displayText)).toEqual(['package.json'])
    })
  })

  describe('extractTerminalFileLinks local path tokens', () => {
    it('detects tilde-prefixed POSIX paths', () => {
      const links = extractTerminalFileLinks('~/Documents/Path/file_name')
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({
        pathText: '~/Documents/Path/file_name',
        displayText: '~/Documents/Path/file_name'
      })
    })

    it('detects absolute paths with spaces before the filename', () => {
      const links = extractTerminalFileLinks('/Users/Path/FolderName with Space/content.js')
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({
        pathText: '/Users/Path/FolderName with Space/content.js',
        displayText: '/Users/Path/FolderName with Space/content.js'
      })
    })

    it('stops a spaced absolute path before trailing prose', () => {
      const links = extractTerminalFileLinks(
        'Open /Users/Path/FolderName with Space/content.js for details'
      )
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({
        pathText: '/Users/Path/FolderName with Space/content.js',
        displayText: '/Users/Path/FolderName with Space/content.js'
      })
    })

    it('detects an extensionless absolute path ending in a spaced segment', () => {
      const links = extractTerminalFileLinks('/Users/alice/My Folder')
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({
        pathText: '/Users/alice/My Folder',
        displayText: '/Users/alice/My Folder'
      })
    })

    it('trims terminal padding after line-ending spaced paths', () => {
      const links = extractTerminalFileLinks('/Users/alice/My Folder   ')
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({
        pathText: '/Users/alice/My Folder',
        displayText: '/Users/alice/My Folder'
      })
    })

    it('does not treat mid-line command arguments as line-ending spaced paths', () => {
      const links = extractTerminalFileLinks('run /usr/bin/env node, then continue')
      expect(links.map((link) => link.pathText)).not.toContain('/usr/bin/env node')
    })

    it('keeps trailing separators on directory-like absolute paths', () => {
      const links = extractTerminalFileLinks('/Users/alice/worktree/')
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({
        pathText: '/Users/alice/worktree/',
        displayText: '/Users/alice/worktree/'
      })
    })

    it('does not linkify root-only or relative trailing separator tokens', () => {
      expect(extractTerminalFileLinks('progress 1 / 3')).toEqual([])
      expect(extractTerminalFileLinks('/')).toEqual([])
      expect(extractTerminalFileLinks('./')).toEqual([])
      expect(extractTerminalFileLinks('../')).toEqual([])
      expect(extractTerminalFileLinks('~/')).toEqual([])
      expect(extractTerminalFileLinks('C:\\')).toEqual([])
    })

    it('detects an extensionless relative path ending in a spaced segment', () => {
      const links = extractTerminalFileLinks('./My Folder')
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({
        pathText: './My Folder',
        displayText: './My Folder'
      })
    })

    it('detects framework route paths with bracket and paren segments', () => {
      const links = extractTerminalFileLinks(
        'Error in app/(shop)/products/[productId]/page.tsx:42:7'
      )
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({
        pathText: 'app/(shop)/products/[productId]/page.tsx',
        line: 42,
        column: 7,
        displayText: 'app/(shop)/products/[productId]/page.tsx:42:7'
      })
    })

    it('handles large spaced path lists without quadratic overlap scans', () => {
      const line = Array.from({ length: 20_000 }, () => '/tmp/Foo Bar/file').join(', ')

      const links = extractTerminalFileLinks(line)

      expect(links).toHaveLength(20_000)
      expect(links[0].pathText).toBe('/tmp/Foo Bar/file')
    }, 5_000)
  })

  it('supports Windows cwd resolution for terminal file links', () => {
    expect(
      resolveTerminalFileLink(
        {
          pathText: '.\\src\\file.ts',
          line: 12,
          column: 3,
          startIndex: 0,
          endIndex: 13,
          displayText: '.\\src\\file.ts:12:3'
        },
        'C:\\repo'
      )
    ).toEqual({
      absolutePath: 'C:/repo/src/file.ts',
      line: 12,
      column: 3
    })
  })

  it('resolves tilde-prefixed POSIX paths against the cwd user home', () => {
    expect(
      resolveTerminalFileLink(
        {
          pathText: '~/Documents/Path/file_name',
          line: null,
          column: null,
          startIndex: 0,
          endIndex: 26,
          displayText: '~/Documents/Path/file_name'
        },
        '/Users/alice/project'
      )
    ).toEqual({
      absolutePath: '/Users/alice/Documents/Path/file_name',
      line: null,
      column: null
    })
  })

  it('resolves tilde-prefixed Windows paths against the cwd user home', () => {
    expect(
      resolveTerminalFileLink(
        {
          pathText: '~/Documents/Path/file_name',
          line: null,
          column: null,
          startIndex: 0,
          endIndex: 26,
          displayText: '~/Documents/Path/file_name'
        },
        'C:\\Users\\Alice\\project'
      )
    ).toEqual({
      absolutePath: 'C:/Users/Alice/Documents/Path/file_name',
      line: null,
      column: null
    })
  })

  it('resolves tilde-prefixed paths against explicit terminal home when cwd is outside home', () => {
    expect(
      resolveTerminalFileLink(
        {
          pathText: '~/Documents/Path/file_name',
          line: null,
          column: null,
          startIndex: 0,
          endIndex: 26,
          displayText: '~/Documents/Path/file_name'
        },
        '/workspace/project',
        '/home/alice'
      )
    ).toEqual({
      absolutePath: '/home/alice/Documents/Path/file_name',
      line: null,
      column: null
    })
  })

  it('resolves exact repo-relative OSC hyperlink text', () => {
    expect(resolveTerminalFileLinkText('docs/README.md', '/repo')).toEqual({
      absolutePath: '/repo/docs/README.md',
      line: null,
      column: null
    })
  })

  it('keeps line and column suffixes from exact OSC hyperlink text', () => {
    expect(resolveTerminalFileLinkText('docs/README.md:12:3', '/repo')).toEqual({
      absolutePath: '/repo/docs/README.md',
      line: 12,
      column: 3
    })
  })

  it('does not resolve partial text as an OSC hyperlink target', () => {
    expect(resolveTerminalFileLinkText('open docs/README.md', '/repo')).toBeNull()
  })
})