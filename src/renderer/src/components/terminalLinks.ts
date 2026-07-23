// 终端内链接识别与点击（对齐 VS Code TerminalLinkManager + LocalFile/Uri link detector）。
//
// 识别两类链接：
//   1. 文件链接：绝对/相对路径（含 Windows C:\ 与 ~ / ./foo），支持多种行:列后缀格式。
//      点击 → 用 pi-desktop 编辑器打开（onOpenFile / openFileInEditor），
//      若编辑器不可用则回退到系统默认程序（openFileWithSystem）。
//   2. URL 链接：http(s)/file/ftp 等 scheme。点击 → window.open 经主进程
//      setWindowOpenHandler 拦截后调 shell.openExternal 用默认浏览器打开
//      （保留用户手势，不弹安全对话框）。
//
// 与 VS Code 的对齐：
//  - 移植了 VS Code terminalLinkParsing.detectLinks 的链接后缀解析（:line、:line:col、
//    (line)、(line,col)、"file", line col 等格式），见 generateLinkSuffixRegex。
//  - 移植了 VS Code 的路径正则（unixLocalLinkClause / winLocalLinkClause），含 git diff
//    的 a/b 前缀处理。
//  - hover 时始终显示 pointer cursor + underline，对齐 VS Code TerminalLink.hover
//    的高置信链接默认装饰行为。
//  - 点击需按住 Ctrl/Cmd 修饰键才激活，对齐 VS Code _isLinkActivationModifierDown。

/** 链接类型。 */
export type TerminalLinkType = 'file' | 'url';

export interface TerminalLinkMatch {
  type: TerminalLinkType;
  /** 完整匹配文本（用于激活时打开）。 */
  text: string;
  /** 解析出的文件路径（file 类型）。 */
  path?: string;
  /** 行号（1-based，file 类型可选）。 */
  line?: number;
  /** 列号（1-based，file 类型可选）。 */
  col?: number;
  /** 行号结束（范围选择，file 类型可选）。 */
  lineEnd?: number;
  /** 列号结束（范围选择，file 类型可选）。 */
  colEnd?: number;
  /** buffer 中的起止列（含/不含）。 */
  startCol: number;
  endCol: number;
}

// ─── 链接后缀解析（移植 VS Code terminalLinkParsing.ts） ───────────────────────

interface LinkSuffix {
  row: number | undefined;
  col: number | undefined;
  rowEnd: number | undefined;
  colEnd: number | undefined;
  text: string;
  index: number;
}

/**
 * 生成匹配链接后缀的正则，支持多种行:列格式。
 * 移植 VS Code generateLinkSuffixRegex。
 */
function generateLinkSuffixRegex(eolOnly: boolean): RegExp {
  let ri = 0;
  let ci = 0;
  let rei = 0;
  let cei = 0;
  const r = () => `(?<row${ri++}>\\d+)`;
  const c = () => `(?<col${ci++}>\\d+)`;
  const re = () => `(?<rowEnd${rei++}>\\d+)`;
  const ce = () => `(?<colEnd${cei++}>\\d+)`;

  const eolSuffix = eolOnly ? '$' : '';

  // 支持的格式（注释中 foo=路径，339=行号，12=列号）：
  //   foo:339
  //   foo:339:12
  //   foo:339:12-789
  //   foo:339:12-341.789
  //   foo:339.12
  //   foo 339
  //   foo 339:12
  //   foo 339.12
  //   foo#339
  //   foo#339:12
  //   foo#339.12
  //   foo, 339
  //   "foo",339
  //   "foo",339:12
  //   "foo",339.12
  //   "foo",339.12-789
  //   "foo",339.12-341.789
  //   "foo", line 339
  //   "foo", line 339, col 12
  //   "foo", line 339, column 12
  //   "foo":line 339
  //   "foo":line 339, col 12
  //   "foo": line 339
  //   "foo": line 339, col 12
  //   "foo" on line 339
  //   "foo", lines 339-341
  //   "foo", lines 339-341, characters 12-789
  //   foo(339)
  //   foo(339,12)
  //   foo (339)
  //   foo (339,12)
  //   foo: (339)
  //   foo: (339,12)
  //   foo(339:12)
  //   foo (339:12)

  const clauses = [
    // foo:339 / foo:339:12 / foo:339:12-789 / foo:339:12-341.789 / foo:339.12
    // foo 339 / foo 339:12 / foo 339.12
    // foo#339 / foo#339:12 / foo#339.12
    // foo, 339 / "foo",339 / "foo",339:12 / "foo",339.12
    `(?::|#| |['"],|, )${r()}([:.]${c()}(?:-(?:${re()}\\.)?${ce()})?)?${eolSuffix}`,

    // "foo", line 339 / "foo", line 339, col 12 / "foo", line 339, column 12
    // "foo":line 339 / "foo":line 339, col 12 / "foo": line 339
    // "foo" on line 339 / "foo" on line 339, col 12
    // "foo", lines 339-341 / "foo", lines 339-341, characters 12-789
    `['"]?(?:,? |: ?| on )lines? ${r()}(?:-${re()})?(?:,? (?:col(?:umn)?|characters?) ${c()}(?:-${ce()})?)?${eolSuffix}`,

    // foo(339) / foo(339,12) / foo(339, 12)
    // foo (339) / foo (339,12) / foo (339, 12)
    // foo: (339) / foo: (339,12) / foo: (339, 12)
    // foo(339:12) / foo (339:12)
    `:? ?[\\[\\(]${r()}(?:(?:, ?|:)${c()})?[\\]\\)]${eolSuffix}`,
  ];

  const suffixClause = clauses
    .join('|')
    // 允许非断行空格（ascii 160）
    .replace(/ /g, `[${'\u00A0'} ]`);

  return new RegExp(`(${suffixClause})`, eolOnly ? undefined : 'g');
}

/** 链接后缀匹配正则（全局，匹配所有后缀）。 */
const linkSuffixRegex = generateLinkSuffixRegex(false);
/** 链接后缀匹配正则（仅行末，用于从链接文本提取后缀）。 */
const linkSuffixRegexEol = generateLinkSuffixRegex(true);

/** 从匹配结果提取后缀信息。 */
function toLinkSuffix(match: RegExpExecArray | null): LinkSuffix | null {
  const groups = match?.groups;
  if (!groups) return null;
  const parseIntOpt = (v: string | undefined) => v !== undefined ? parseInt(v, 10) : undefined;
  return {
    row: parseIntOpt(groups.row0 ?? groups.row1 ?? groups.row2),
    col: parseIntOpt(groups.col0 ?? groups.col1 ?? groups.col2),
    rowEnd: parseIntOpt(groups.rowEnd0 ?? groups.rowEnd1 ?? groups.rowEnd2),
    colEnd: parseIntOpt(groups.colEnd0 ?? groups.colEnd1 ?? groups.colEnd2),
    text: match![0],
    index: match!.index,
  };
}

/** 从一行文本中检测所有链接后缀。 */
function detectLinkSuffixes(line: string): LinkSuffix[] {
  const results: LinkSuffix[] = [];
  linkSuffixRegex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = linkSuffixRegex.exec(line)) !== null) {
    const suffix = toLinkSuffix(m);
    if (!suffix) break;
    results.push(suffix);
  }
  return results;
}

/** 从链接文本中提取末端的行:列后缀信息。 */
function getLinkSuffix(link: string): LinkSuffix | null {
  return toLinkSuffix(linkSuffixRegexEol.exec(link));
}

/** 移除链接文本中的行:列后缀。 */
function removeLinkSuffix(link: string): string {
  const suffix = getLinkSuffix(link);
  if (!suffix) return link;
  return link.substring(0, suffix.index);
}

// ─── 路径检测（移植 VS Code 的 unixLocalLinkClause / winLocalLinkClause） ─────

const enum PathConstants {
  PathPrefix = '(?:\\.\\.?|\\~|file:\\/\\/)',
  PathSeparatorClause = '\\/',
  ExcludedPathCharactersClause = '[^\\0<>\\?\\s!`&*()\'":;\\\\]',
  ExcludedStartPathCharactersClause = '[^\\0<>\\?\\s!`&*()\\[\\]\'":;\\\\]',

  WinOtherPathPrefix = '\\.\\.?|\\~',
  WinPathSeparatorClause = '(?:\\\\|\\/)',
  WinExcludedPathCharactersClause = '[^\\0<>\\?\\|\\/\\s!`&*()\'":;]',
  WinExcludedStartPathCharactersClause = '[^\\0<>\\?\\|\\/\\s!`&*()\\[\\]\'":;]',
}

/** Unix 路径正则。 */
const unixLocalLinkClause =
  '(?:(?:' + PathConstants.PathPrefix + '|(?:' + PathConstants.ExcludedStartPathCharactersClause + PathConstants.ExcludedPathCharactersClause + '*))?(?:' + PathConstants.PathSeparatorClause + '(?:' + PathConstants.ExcludedPathCharactersClause + ')+)+)';

/** Windows 盘符前缀。 */
const winDrivePrefix = '(?:\\\\\\\\\\?\\\\|file:\\/\\/\\/)?[a-zA-Z]:';

/** Windows 路径正则。 */
const winLocalLinkClause =
  '(?:(?:' + `(?:${winDrivePrefix}|${PathConstants.WinOtherPathPrefix})` + '|(?:' + PathConstants.WinExcludedStartPathCharactersClause + PathConstants.WinExcludedPathCharactersClause + '*))?(?:' + PathConstants.WinPathSeparatorClause + '(?:' + PathConstants.WinExcludedPathCharactersClause + ')+)+)';

/** Git diff 的 a/b 前缀正则。 */
const diffFilePrefix = '[abciow]\\/';

/** 带后缀的链接路径字符正则（路径后紧跟后缀）。 */
const linkWithSuffixPathCharacters = /(?<path>(?:file:\/\/\/)?[^\s\|<>\[\({][^\s\|<>]*)$/;

// ─── 核心检测函数 ────────────────────────────────────────────────────────────

/**
 * 从一行文本中检测所有（file + url）链接。
 * 移植 VS Code detectLinks + detectLinkSuffixes + detectPathsNoSuffix。
 *
 * @param line 一行文本
 * @param isWindows 目标操作系统是否为 Windows（影响路径解析）
 * @param resolvePath 可选的路径解析函数（相对路径 → 绝对路径）
 */
export function detectLinksInLine(
  line: string,
  isWindows?: boolean,
  resolvePath?: (p: string) => string,
): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  if (!line) return matches;

  // ── 1. URL 链接 ──
  // 移植 VS Code LinkComputer 的 scheme 识别。
  const urlRe = /\b([a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+)/gi;
  let um: RegExpExecArray | null;
  while ((um = urlRe.exec(line)) !== null) {
    matches.push({
      type: 'url',
      text: um[1],
      startCol: um.index,
      endCol: um.index + um[1].length,
    });
  }

  // ── 2. 文件链接（先检测后缀，再检测无后缀路径） ──
  // 2a：通过后缀检测
  const suffixes = detectLinkSuffixes(line);
  for (const suffix of suffixes) {
    const beforeSuffix = line.substring(0, suffix.index);
    const possiblePathMatch = beforeSuffix.match(linkWithSuffixPathCharacters);
    if (possiblePathMatch?.groups?.path) {
      let path = possiblePathMatch.groups.path;
      const pathStart = possiblePathMatch.index!;

      // 处理 git diff 的 a/b 前缀
      if (
        (line.startsWith('--- ') || line.startsWith('+++ ')) && pathStart === 4 &&
        (path.startsWith('a/') || path.startsWith('b/') || path.startsWith('c/') ||
         path.startsWith('i/') || path.startsWith('o/') || path.startsWith('w/'))
      ) {
        path = path.slice(2);
      } else if (line.startsWith('diff --git') && path.length >= 2) {
        if (path.startsWith('a/') || path.startsWith('b/')) {
          path = path.slice(2);
        }
      }

      // 已是 URL 一部分的跳过
      const fullStart = pathStart;
      if (line.startsWith('file://', fullStart)) continue;

      let resolvedPath = path;
      if (resolvePath) resolvedPath = resolvePath(resolvedPath);

      matches.push({
        type: 'file',
        text: line.substring(fullStart, suffix.index + suffix.text.length),
        path: resolvedPath,
        line: suffix.row,
        col: suffix.col,
        lineEnd: suffix.rowEnd,
        colEnd: suffix.colEnd,
        startCol: fullStart,
        endCol: suffix.index + suffix.text.length,
      });
    }
  }

  // 2b：检测无后缀的路径
  const pathRegex = new RegExp(
    isWindows ? winLocalLinkClause : unixLocalLinkClause,
    'g',
  );
  let fm: RegExpExecArray | null;
  while ((fm = pathRegex.exec(line)) !== null) {
    let text = fm[0];
    let index = fm.index;
    if (!text) break;

    // 与已有后缀链接重叠则跳过
    if (matches.some(m => index < m.endCol && index + text.length > m.startCol)) continue;

    // 已是 URL 一部分的跳过
    if (line.startsWith('file://', index)) continue;

    // 处理 git diff 的 a/b 前缀
    if (
      ((line.startsWith('--- ') || line.startsWith('+++ ')) && index === 4) ||
      (line.startsWith('diff --git') && (text.startsWith('a/') || text.startsWith('b/')))
    ) {
      text = text.slice(2);
      index += 2;
    }

    let resolvedPath = text;
    if (resolvePath) resolvedPath = resolvePath(resolvedPath);

    matches.push({
      type: 'file',
      text: line.substring(index, index + text.length),
      path: resolvedPath,
      startCol: index,
      endCol: index + text.length,
    });
  }

  return matches;
}

// ─── 链接激活 ─────────────────────────────────────────────────────────────────

/** 链接点击激活处理器：由 XtermTerminal 在创建 link 时绑定。 */
export interface LinkActivationHandlers {
  /** 用 pi-desktop 编辑器打开文件（或系统默认程序作为回退）。 */
  openFile: (path: string, line?: number, col?: number) => void;
  /** 用系统默认浏览器打开外部 URL。 */
  openExternal: (url: string) => void;
}

/** 链接对象接口（buildLink 返回值）。 */
export interface BuiltLink {
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  text: string;
  activate: (event?: MouseEvent, text?: string) => void;
  hover: (event: MouseEvent) => void;
  leave: () => void;
  decorations: { pointerCursor: boolean; underline: boolean };
}

/**
 * 判断事件是否按下了链接激活修饰键（对齐 VS Code _isLinkActivationModifierDown）。
 * Windows/Linux：Ctrl；macOS：Cmd（metaKey）。
 */
function isLinkActivationModifierDown(event: MouseEvent | KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey;
}

/** 获取链接悬停工具提示文本（对齐 VS Code _getLinkHoverString）。 */
function getLinkHoverText(): string {
  return 'Ctrl+click 打开链接';
}

/**
 * 把一个 buffer 行的命中转换成 xterm 的 ILink（对齐 VS Code TerminalLinkDetectorAdapter）。
 *
 * 注意：xterm 6.0.0 的 _handleMouseUp 不会检查 Ctrl/Cmd 修饰键，
 * 所有点击（含普通点击）都会触发 activate。因此我们在 activate 中自行检查修饰键，
 * 只有按住 Ctrl/Cmd 点击时才实际打开链接——对齐 VS Code 的
 * TerminalLinkManager._setupLinkDetector 中的 onDidActivateLink 修饰键检查。
 *
 * hover/leave 中对齐 VS Code TerminalLink.hover：
 *  hover 时始终显示 pointer cursor + underline（不依赖修饰键），
 *  同时显示工具提示（"Ctrl+click 打开链接"）类似 VS Code 的 TerminalHover。
 */
export function buildLink(
  match: TerminalLinkMatch,
  handlers: LinkActivationHandlers,
): BuiltLink {
  // 工具提示元素引用
  let tooltipEl: HTMLElement | null = null;

  const link: BuiltLink = {
    range: {
      start: { x: match.startCol + 1, y: 0 }, // y 由 provider 填充绝对行号
      end: { x: match.endCol + 1, y: 0 },
    },
    text: match.text,
    // 初始 decorations 设为 true，使 xterm 在 _handleNewLink 读取 state 时
    // 拿到正确值并应用装饰（cursor pointer + underline）。
    // xterm 会在 _linkLeave 中自动清除装饰。
    decorations: { pointerCursor: true, underline: true },

    activate: (event?: MouseEvent) => {
      // 对齐 VS Code：只有按住修饰键（Ctrl/Cmd）点击才激活链接
      if (!event || !isLinkActivationModifierDown(event)) {
        return;
      }
      if (match.type === 'url' && match.text) {
        handlers.openExternal(match.text);
      } else if (match.type === 'file' && match.path) {
        handlers.openFile(match.path, match.line, match.col);
      }
    },

    hover: (event: MouseEvent) => {
      // xterm 在 _handleNewLink 初始化 state 时已读取 decorations 初始值
      // （pointerCursor: true, underline: true），自动应用装饰。
      // 此处只需管理工具提示。

      // ── 工具提示（对齐 VS Code TerminalHover，与 linkHandler 的 hover 一致） ──
      // 在链接位置附近显示 "Ctrl+click 打开链接"
      const doc = document;
      const existing = doc.querySelector('.terminal-link-tooltip');
      if (existing) existing.remove();

      tooltipEl = doc.createElement('div');
      tooltipEl.className = 'terminal-link-tooltip';
      tooltipEl.textContent = 'Ctrl+click 打开链接';
      tooltipEl.style.cssText = `
        position: fixed;
        left: ${event.clientX}px;
        top: ${event.clientY - 28}px;
        background: var(--bg-over, #2d2d2d);
        color: var(--text, #fff);
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 12px;
        pointer-events: none;
        z-index: 1000;
        white-space: nowrap;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        opacity: 0;
        transition: opacity 0.15s ease;
      `;
      doc.body.appendChild(tooltipEl);
      requestAnimationFrame(() => {
        if (tooltipEl) tooltipEl.style.opacity = '1';
      });
    },

    leave: () => {
      // 提示：xterm 的 _linkLeave 已自动清除装饰（移除 xterm-cursor-pointer class、
      // 隐藏 underline），此处只需清理工具提示。
      // 移除工具提示
      if (tooltipEl) {
        tooltipEl.remove();
        tooltipEl = null;
      }
    },
  };

  return link;
}
