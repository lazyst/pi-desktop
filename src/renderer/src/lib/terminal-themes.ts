// 终端主题模块（对齐 orca lib/terminal-theme.ts / terminal-themes-data.ts）。
//
// 把「xterm 主题对象」从 theme.ts 中独立出来，使主题定义、背景/前景解析、明暗切换
// 成为一个专注、可单测的模块，不与 DOM 主题上色（data-theme 属性、tokens.css 驱动）耦合。
//
// 设计要点（保持既有「背景跟随容器」语义不变）：
//  - 16 色 ANSI + 选区 + 滚动条滑块用 GitHub 官方暗/亮调色板，与 tokens.css 的 DOM 令牌
//    共享同一套语义，使 CLI 输出与窗口同属一个视觉语言（等值约束由 theme.test.ts 守护）。
//  - 背景/前景/光标不写死 hex，运行时从容器 computed 值读取（--bg-app / --text），对齐 VS Code
//    terminalInstance.getBackgroundColor 的「与容器像素一致」语义，消除主题切换/浅色模式下的
//    背景错位露边闪烁。无 DOM（测试/SSR）时回退到各主题的静态等价色。
//
// xterm 6.0.0：WebGL 渲染优先、内建 DOM 兜底，颜色只来自 theme 选项，不支持 CSS 变量覆盖，
// 故必须显式构造 ITheme 对象（不能靠 CSS 变量）。
import type { Theme } from '../types';
import type { ITheme } from '@xterm/xterm';

// 16 色 ANSI + 选区 + 滚动条滑块（GitHub 官方暗/亮调色板）。背景/前景/光标不在此（运行时取）。
// 滚动条滑块配色（scrollbarSlider*）供 xterm 6.0.0 的 VS Code 风格覆盖滚动条使用，与主题一致。
const ANSI: Record<'dark' | 'light', Omit<ITheme, 'background' | 'foreground' | 'cursor' | 'cursorAccent'>> = {
  dark: {
    selectionBackground: 'rgba(124, 156, 255, 0.30)',
    black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
    blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
    brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
    brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
    scrollbarSliderBackground: 'rgba(201, 209, 217, 0.15)',
    scrollbarSliderHoverBackground: 'rgba(201, 209, 217, 0.40)',
    scrollbarSliderActiveBackground: 'rgba(124, 156, 255, 0.60)',
  },
  light: {
    selectionBackground: 'rgba(59, 91, 219, 0.20)',
    black: '#484f58', red: '#cf222e', green: '#116329',
    yellow: '#9a6700', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#b1bac4',
    brightBlack: '#6e7681', brightRed: '#a40e26', brightGreen: '#1a7f37',
    brightYellow: '#bf8700', brightBlue: '#218bff', brightMagenta: '#a475f9',
    brightCyan: '#3192aa', brightWhite: '#d1d9e0',
    scrollbarSliderBackground: 'rgba(31, 35, 40, 0.16)',
    scrollbarSliderHoverBackground: 'rgba(31, 35, 40, 0.38)',
    scrollbarSliderActiveBackground: 'rgba(59, 91, 219, 0.55)',
  },
};

/** 运行时读取容器语义背景色（--bg-app 的 computed 值）。
 * 对齐 VS Code getBackgroundColor：终端背景与容器严格一致，不露黑边。
 * 无 DOM（测试/SSR）时回退到各主题的静态等价色。 */
export function resolveTerminalBackground(theme: Theme): string {
  try {
    const root = document.documentElement;
    const v = getComputedStyle(root).getPropertyValue('--bg-app').trim();
    if (v) return v;
  } catch { /* 非浏览器环境（测试）回退 */ }
  return theme === 'light' ? '#ffffff' : '#0d1117';
}

/** 前景/光标色：取自容器 --text（无 DOM 时回退各主题等价前景）。 */
export function resolveTerminalForeground(theme: Theme): string {
  try {
    const root = document.documentElement;
    const v = getComputedStyle(root).getPropertyValue('--text').trim();
    if (v) return v;
  } catch { /* 非浏览器环境（测试）回退 */ }
  return theme === 'light' ? '#1f2328' : '#c9d1d9';
}

/** 构造指定主题的 xterm ITheme：背景取容器 --bg-app、前景/光标取容器 --text，
 * 其余 16 色 + 滚动条滑块用 GitHub 官方调色板。背景跟随容器，从根上消除露边闪。 */
export function getTermTheme(theme: Theme): ITheme {
  const bg = resolveTerminalBackground(theme);
  const fg = resolveTerminalForeground(theme);
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    ...ANSI[theme],
  };
}

/** 覆盖两套主题（dark/light）的 xterm 主题对象。背景/前景运行时解析，故每次取都反映当前容器色。 */
export const TERM_THEMES: Record<Theme, ITheme> = {
  dark: getTermTheme('dark'),
  light: getTermTheme('light'),
};
