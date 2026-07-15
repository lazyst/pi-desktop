import { pi } from './ipc';
import type { Theme } from './types';
import type { ITheme } from '@xterm/xterm';

const listeners = new Set<(t: Theme) => void>();

// 终端（xterm 6.0.0：WebGL 渲染优先、内建 DOM 兜底，颜色只来自 theme 选项，不支持 CSS 变量覆盖）
// 与 tokens.css 的 DOM 令牌共享同一套 GitHub 语义：背景=--bg-app、前景=--text、
// 选区=accent 半透明；16 色 ANSI 用 GitHub 官方暗/亮调色板，使 CLI 输出与窗口
// 同属一个视觉语言。与 tokens.css 的等值约束由 theme.test.ts 守护，防漂移。
// 滚动条滑块配色（scrollbarSlider*）供 xterm 6.0.0 的 VS Code 风格覆盖滚动条使用，
// 使其与主题一致。
export const TERM_THEMES: Record<Theme, ITheme> = {
  dark: {
    background: '#0d1117',
    foreground: '#c9d1d9',
    cursor: '#c9d1d9',
    cursorAccent: '#0d1117',
    selectionBackground: 'rgba(124, 156, 255, 0.30)',
    black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
    blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
    brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
    brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
    // xterm 6.0.0 覆盖滚动条滑块（VS Code 风格）：默认淡、悬停加深、拖拽偏 accent
    scrollbarSliderBackground: 'rgba(201, 209, 217, 0.15)',
    scrollbarSliderHoverBackground: 'rgba(201, 209, 217, 0.40)',
    scrollbarSliderActiveBackground: 'rgba(124, 156, 255, 0.60)',
  },
  light: {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#1f2328',
    cursorAccent: '#ffffff',
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

// 同步读取主进程在窗口创建时经 additionalArguments 注入的初始 config（见 preload 的
// getInitialConfig），使首屏主题（含随后打开的终端）无需等待异步 IPC，杜绝暗→亮闪烁。
function readInitialTheme(): Theme {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    if (cfg && (cfg.theme === 'light' || cfg.theme === 'dark')) return cfg.theme;
  } catch { /* 无注入配置（如测试）时回退默认主题 */ }
  return 'dark';
}

// 主题持久化改为主进程 config（见 docs/adr/0001），不再用 localStorage。

// Drive the whole UI from a single attribute on <html>. `:root` holds the dark
// defaults; `[data-theme="light"]` (in tokens.css) overrides the same token names,
// so every component — sidebar, title bar, modals — follows the theme for free.
function paint(t: Theme) {
  document.documentElement.setAttribute('data-theme', t);
}

export function getTheme(): Theme {
  return (document.documentElement.getAttribute('data-theme') as Theme) ?? 'dark';
}

export function setTheme(t: Theme) {
  paint(t);
  // config 经异步 IPC 持久化；用 .catch 吸收拒绝（try/catch 抓不到 Promise 拒绝）。
  pi.setConfig({ theme: t }).catch(() => {});
  listeners.forEach((l) => l(t));
}

export function onThemeChange(cb: (t: Theme) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// 首屏尽早上色以避免闪烁：config 在主进程、须经异步 IPC 读取，
// 故先以 readInitialTheme()（同步注入值，回退 'dark'）上色，App 挂载后由 initTheme() 校正。
paint(readInitialTheme());

// App 挂载后调用：从主进程配置读取持久化主题并应用（config 为异步来源）。
export async function initTheme(): Promise<void> {
  try {
    const cfg = await pi.getConfig();
    // 同步初始主题（readInitialTheme）已先行上色；仅当与持久化值不一致才纠正并持久化，
    // 避免每次启动都多发一次无谓的 config 写与 listener 通知。
    if ((cfg.theme === 'light' || cfg.theme === 'dark') && cfg.theme !== getTheme()) {
      setTheme(cfg.theme);
    }
  } catch {
    /* 读取失败则保持默认主题 */
  }
}
