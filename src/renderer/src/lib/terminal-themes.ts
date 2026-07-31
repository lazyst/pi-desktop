// 终端主题模块（对齐 orca lib/terminal-theme.ts / terminal-themes-data.ts）。
//
// 把「xterm 主题对象」从 theme.ts 中独立出来，使主题定义、背景/前景解析、明暗切换
// 成为一个专注、可单测的模块，不与 DOM 主题上色（data-theme / data-theme-family 属性、
// tokens.css 驱动）耦合。
//
// 设计要点（保持既有「背景跟随容器」语义不变）：
//  - 16 色 ANSI + 选区 + 滚动条滑块按主题家族（github / aurora / mineral）分别定义调色板。
//  - 背景/前景/光标不写死 hex，运行时从容器 computed 值读取（--bg-app / --text），对齐 VS Code
//    terminalInstance.getBackgroundColor 的「与容器像素一致」语义，消除主题切换/浅色模式下的
//    背景错位露边闪烁。无 DOM（测试/SSR）时回退到各主题的静态等价色。
//
// xterm 6.0.0：WebGL 渲染优先、内建 DOM 兜底，颜色只来自 theme 选项，不支持 CSS 变量覆盖，
// 故必须显式构造 ITheme 对象（不能靠 CSS 变量）。
import type { ThemeFamily, ThemeVariant } from '../types';
import type { ITheme } from '@xterm/xterm';

type AnsiPalette = Omit<ITheme, 'background' | 'foreground' | 'cursor' | 'cursorAccent'>;

// 16 色 ANSI + 选区 + 滚动条滑块（按主题家族分别定义）。背景/前景/光标不在此（运行时取）。
// 滚动条滑块配色（scrollbarSlider*）供 xterm 6.0.0 的 VS Code 风格覆盖滚动条使用，与主题一致。
const ANSI: Record<ThemeFamily, Record<ThemeVariant, AnsiPalette>> = {
  // ── GitHub（官方调色板，暗/亮均源自 GitHub 设计语言）──
  github: {
    dark: {
      selectionBackground: 'rgba(124, 156, 255, 0.30)',
      black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
      blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
      brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
      brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
      scrollbarSliderBackground: 'rgba(230, 237, 243, 0.15)',
      scrollbarSliderHoverBackground: 'rgba(230, 237, 243, 0.40)',
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
  },

  // ── Aurora（冷蓝渐变风格，调色板偏冷紫）──
  aurora: {
    dark: {
      selectionBackground: 'rgba(99, 148, 255, 0.30)',
      black: '#3b4252', red: '#ff6b7a', green: '#34d399', yellow: '#fbbf24',
      blue: '#6394ff', magenta: '#a78bfa', cyan: '#67e8f9', white: '#c8d0dc',
      brightBlack: '#5a6278', brightRed: '#ff8a96', brightGreen: '#6ee7b7',
      brightYellow: '#fcd34d', brightBlue: '#7ba8ff', brightMagenta: '#c4b5fd',
      brightCyan: '#a5f3fc', brightWhite: '#e8edf5',
      scrollbarSliderBackground: 'rgba(200, 208, 220, 0.12)',
      scrollbarSliderHoverBackground: 'rgba(200, 208, 220, 0.35)',
      scrollbarSliderActiveBackground: 'rgba(99, 148, 255, 0.55)',
    },
    light: {
      selectionBackground: 'rgba(74, 130, 232, 0.20)',
      black: '#3b4252', red: '#dc2626', green: '#059669',
      yellow: '#d97706', blue: '#4a82e8', magenta: '#7c3aed', cyan: '#0891b2', white: '#9ca3af',
      brightBlack: '#6b7280', brightRed: '#ef4444', brightGreen: '#10b981',
      brightYellow: '#f59e0b', brightBlue: '#3b82f6', brightMagenta: '#8b5cf6',
      brightCyan: '#06b6d4', brightWhite: '#d1d5db',
      scrollbarSliderBackground: 'rgba(31, 35, 40, 0.14)',
      scrollbarSliderHoverBackground: 'rgba(31, 35, 40, 0.34)',
      scrollbarSliderActiveBackground: 'rgba(74, 130, 232, 0.50)',
    },
  },

  // ── Mineral（蓝绿翡翠风格，调色板偏暖/绿松石）──
  mineral: {
    dark: {
      selectionBackground: 'rgba(45, 212, 191, 0.25)',
      black: '#2d3748', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
      blue: '#60a5fa', magenta: '#a78bfa', cyan: '#2dd4bf', white: '#cbd5e1',
      brightBlack: '#4a5568', brightRed: '#fca5a5', brightGreen: '#86efac',
      brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#c4b5fd',
      brightCyan: '#5eead4', brightWhite: '#e2e8f0',
      scrollbarSliderBackground: 'rgba(194, 206, 220, 0.12)',
      scrollbarSliderHoverBackground: 'rgba(194, 206, 220, 0.35)',
      scrollbarSliderActiveBackground: 'rgba(45, 212, 191, 0.55)',
    },
    light: {
      selectionBackground: 'rgba(13, 148, 136, 0.18)',
      black: '#374151', red: '#b91c1c', green: '#047857',
      yellow: '#a16207', blue: '#2563eb', magenta: '#6d28d9', cyan: '#0d9488', white: '#9ca3af',
      brightBlack: '#6b7280', brightRed: '#dc2626', brightGreen: '#059669',
      brightYellow: '#ca8a04', brightBlue: '#3b82f6', brightMagenta: '#7c3aed',
      brightCyan: '#0f766e', brightWhite: '#d1d5db',
      scrollbarSliderBackground: 'rgba(31, 35, 40, 0.14)',
      scrollbarSliderHoverBackground: 'rgba(31, 35, 40, 0.34)',
      scrollbarSliderActiveBackground: 'rgba(13, 148, 136, 0.50)',
    },
  },
};

// 各家族暗/亮色下无 DOM 时的回退背景/前景色（与 tokens.css 中对应家族的 :root / [data-theme="light"] 一致）。
const FALLBACK_BG: Record<ThemeFamily, Record<ThemeVariant, string>> = {
  github:  { dark: '#0d1117', light: '#ffffff' },
  aurora:  { dark: '#0d1117', light: '#f5f7fb' },
  mineral: { dark: '#0f1419', light: '#f0ebe3' },
};
const FALLBACK_FG: Record<ThemeFamily, Record<ThemeVariant, string>> = {
  github:  { dark: '#e6edf3', light: '#0d1117' },
  aurora:  { dark: '#e8edf5', light: '#1a1f2e' },
  mineral: { dark: '#e2e8f0', light: '#1a1e24' },
};

/** 运行时读取容器语义背景色（--bg-app 的 computed 值）。
 * 对齐 VS Code getBackgroundColor：终端背景与容器严格一致，不露黑边。
 * 无 DOM（测试/SSR）时回退到各主题家族的静态等价色。 */
export function resolveTerminalBackground(family: ThemeFamily, variant: ThemeVariant): string {
  try {
    const root = document.documentElement;
    const v = getComputedStyle(root).getPropertyValue('--bg-app').trim();
    if (v) return v;
  } catch { /* 非浏览器环境（测试）回退 */ }
  return FALLBACK_BG[family][variant];
}

/** 前景/光标色：取自容器 --text（无 DOM 时回退各主题家族等价前景）。 */
export function resolveTerminalForeground(family: ThemeFamily, variant: ThemeVariant): string {
  try {
    const root = document.documentElement;
    const v = getComputedStyle(root).getPropertyValue('--text').trim();
    if (v) return v;
  } catch { /* 非浏览器环境（测试）回退 */ }
  return FALLBACK_FG[family][variant];
}

/** 构造指定主题家族与变体的 xterm ITheme：背景取容器 --bg-app、前景/光标取容器 --text，
 * 其余 16 色 + 滚动条滑块用对应家族调色板。背景跟随容器，从根上消除露边闪。 */
export function getTermTheme(family: ThemeFamily, variant: ThemeVariant): ITheme {
  const bg = resolveTerminalBackground(family, variant);
  const fg = resolveTerminalForeground(family, variant);
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    ...ANSI[family][variant],
  };
}

/** 覆盖所有主题家族 × 变体的 xterm 主题对象。背景/前景运行时解析，故每次取都反映当前容器色。 */
export const TERM_THEMES: Record<ThemeFamily, Record<ThemeVariant, ITheme>> = {
  github: {
    dark: getTermTheme('github', 'dark'),
    light: getTermTheme('github', 'light'),
  },
  aurora: {
    dark: getTermTheme('aurora', 'dark'),
    light: getTermTheme('aurora', 'light'),
  },
  mineral: {
    dark: getTermTheme('mineral', 'dark'),
    light: getTermTheme('mineral', 'light'),
  },
};
