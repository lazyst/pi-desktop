// 终端内链接识别与点击（对齐 VS Code TerminalLinkManager + LocalFile/Uri link detector）。
//
// 识别两类链接：
//   1. 文件链接：绝对/相对路径（含 Windows C:\ 与 ~ / ./foo），可选 :行:列 后缀。
//      点击 → 通过 onOpenFile 回调由壳（IntegratedPane）在编辑器中打开；
//      同时会尝试匹配工作区根目录转为 (root, relPath) 调用 openPreview。
//   2. URL 链接：http(s)/file/ftp 等 scheme。点击 → 主进程 openExternal 用默认程序打开。
//
// 所有链接均显示下划线和指针光标（对齐 VS Code 高置信度链接的 ILinkDecorations 行为），
// 用户按住 Ctrl/Cmd 点击激活，与 xterm 原生交互一致。
//
// 与 VS Code 的差异（仅适配，不改语义）：
//  - VS Code 用多个 detector + resolver.stat；本项目用一个 provider 覆盖 file+uri，
//    file 存在性校验用本项目已有的 fsStat IPC（轻量、够用）。
//  - VS Code 的「点击需按住修饰键」交互保留（按住 Ctrl/Cmd 点击才激活），与 xterm 原生一致。

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
  /** buffer 中的起止列（含/不含）。 */
  startCol: number;
  endCol: number;
}

/** 行:列后缀正则（对齐 VS Code terminalLinkParsing.generateLinkSuffixRegex 的常用子集）。 */
const SUFFIX_RE =
  /(?::(\d+)(?::(\d+))?)?/;

/** 路径与行号后缀组合：先匹配路径主体，再可选 :line[:col]。 */
function tryMatchFileLine(text: string): { path: string; line?: number; col?: number; end: number } | null {
  // 绝对路径（unix / 或 Windows C:\ 或 ~ 或 ./ 或 ../）
  const pathRe =
    /((?:\/|\.\/|\.\.\/|~)(?:[^:\s"'`)\\|]+)?|\b[a-zA-Z]:[\\/][^:\s"'`)\\|]+)/;
  const m = pathRe.exec(text);
  if (!m) return null;
  const path = m[0];
  const after = text.slice(m.index + path.length);
  const suffix = SUFFIX_RE.exec(after);
  let line: number | undefined;
  let col: number | undefined;
  let end = m.index + path.length;
  if (suffix && suffix[0].length > 0) {
    if (suffix[1] !== undefined) line = parseInt(suffix[1], 10);
    if (suffix[2] !== undefined) col = parseInt(suffix[2], 10);
    end += suffix[0].length;
  }
  return { path, line, col, end };
}

/** 从一行文本中找出所有链接（file + url）。返回命中列表（按出现顺序）。 */
export function detectLinksInLine(
  line: string,
  resolvePath?: (p: string) => string,
): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  if (!line) return matches;

  // URL：http(s):// ftp:// file:// 等（对齐 VS Code LinkComputer 的 scheme 识别）。
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

  // 文件：绝对/相对路径 + 可选 :行:列。
  // 为避免与 URL 的 file:// 重复，URL 已覆盖 file:// 起头，这里从路径起始字符匹配。
  const fileRe = /(\/|\.\/|\.\.\/|~|[a-zA-Z]:[\\/])[^\s"'`)\\|]*/g;
  let fm: RegExpExecArray | null;
  while ((fm = fileRe.exec(line)) !== null) {
    // 已是 URL 一部分的（如 file:///...）跳过。
    if (line.startsWith('file://', fm.index)) continue;
    const parsed = tryMatchFileLine(line.slice(fm.index));
    if (!parsed) continue;
    let path = parsed.path;
    if (resolvePath) path = resolvePath(path);
    matches.push({
      type: 'file',
      text: line.slice(fm.index, parsed.end),
      path,
      line: parsed.line,
      col: parsed.col,
      startCol: fm.index,
      endCol: parsed.end,
    });
  }

  return matches;
}

/** 链接点击激活处理器：由 XtermTerminal 在创建 link 时绑定。 */
export interface LinkActivationHandlers {
  openFile: (path: string, line?: number, col?: number) => void;
  openExternal: (url: string) => void;
}

/**
 * 把一个 buffer 行的命中转换成 xterm 的 ILink（对齐 VS Code TerminalLinkDetectorAdapter）。
 *
 * 注意：xterm 6.0.0 的 _handleMouseUp 不会检查 Ctrl/Cmd 修饰键，
 * 所有点击（含普通点击）都会触发 activate。因此我们在 activate 中自行检查修饰键，
 * 只有按住 Ctrl/Cmd 才执行打开操作。
 *
 * hover/leave 方法动态控制 decorations：
 * - 鼠标悬停时检查修饰键状态，仅当 Ctrl/Cmd 按下时才显示下划线和指针光标
 * - 鼠标离开时清除 decorations
 * - 对齐 VS Code 的 _enableDecorations/_disableDecorations 行为
 */
export function buildLink(
  match: TerminalLinkMatch,
  handlers: LinkActivationHandlers,
): {
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  text: string;
  activate: (event?: MouseEvent) => void;
  hover: (event: MouseEvent) => void;
  leave: () => void;
  decorations?: { pointerCursor: boolean; underline: boolean };
} {
  return {
    range: {
      start: { x: match.startCol + 1, y: 0 }, // y 由 provider 填充绝对行号
      end: { x: match.endCol + 1, y: 0 },
    },
    text: match.text,
    // 初始 decorations 为 false，xterm 的 proxy 会接管，hover 时动态控制
    decorations: { pointerCursor: false, underline: false },
    activate: (event?: MouseEvent) => {
      // xterm 6.0.0 不检查修饰键就调 activate，我们在此自行检查：
      // 只有按住 Ctrl/Cmd 才激活链接，普通点击不触发（对齐 VS Code 交互）。
      if (!event || (!event.ctrlKey && !event.metaKey)) {
        return;
      }
      if (match.type === 'url' && match.text) {
        handlers.openExternal(match.text);
      } else if (match.type === 'file' && match.path) {
        handlers.openFile(match.path, match.line, match.col);
      }
    },
    // hover：鼠标悬停时根据修饰键状态动态显示 decorations
    // 对齐 VS Code 的 _enableDecorations 逻辑：仅当 Ctrl/Cmd 按下时显示下划线和指针
    hover(event: MouseEvent): void {
      const modifierDown = event.ctrlKey || event.metaKey;
      // 动态修改 decorations（xterm 的 proxy 会监听变化并更新视觉）
      // 注意：this 指向返回的对象，decorations 已被 xterm 替换为 proxy
      if (this.decorations) {
        this.decorations.pointerCursor = modifierDown;
        this.decorations.underline = modifierDown;
      }
    },
    // leave：鼠标离开时清除 decorations
    leave(): void {
      if (this.decorations) {
        this.decorations.pointerCursor = false;
        this.decorations.underline = false;
      }
    },
  };
}
