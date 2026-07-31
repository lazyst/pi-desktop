// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TERM_THEMES, getTermTheme } from '../terminal-themes';

const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles/tokens.css'), 'utf-8');

// 抽取某主题块内某个 CSS 变量的值。selector 如 ':root {'、'[data-theme="light"] {'、
// '[data-theme-family="aurora"] {'、'[data-theme-family="aurora"][data-theme="light"] {'。
function cssVar(selector: string, name: string): string {
  const block = css.split(selector)[1]?.split('}')[0] ?? '';
  const m = block.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : '';
}

describe('terminal-themes 与 tokens.css 同源（从独立模块导出）', () => {
  // ── GitHub 家族 ──
  it('github 暗色：终端背景/前景 = DOM 的 --bg-app / --text', () => {
    expect(TERM_THEMES.github.dark.background).toBe(cssVar(':root {', 'bg-app'));
    expect(TERM_THEMES.github.dark.foreground).toBe(cssVar(':root {', 'text'));
  });

  it('github 亮色：终端背景/前景 = DOM 的 --bg-app / --text', () => {
    expect(TERM_THEMES.github.light.background).toBe(cssVar('[data-theme="light"] {', 'bg-app'));
    expect(TERM_THEMES.github.light.foreground).toBe(cssVar('[data-theme="light"] {', 'text'));
  });

  it('github 选区色复用 accent（冷静蓝签名）', () => {
    expect(TERM_THEMES.github.dark.selectionBackground).toContain('124, 156, 255');
    expect(TERM_THEMES.github.light.selectionBackground).toContain('59, 91, 219');
  });

  // ── Aurora 家族 ──
  it('aurora 暗色：终端背景/前景 = DOM 的 --bg-app / --text', () => {
    expect(TERM_THEMES.aurora.dark.background).toBe(cssVar('[data-theme-family="aurora"] {', 'bg-app'));
    expect(TERM_THEMES.aurora.dark.foreground).toBe(cssVar('[data-theme-family="aurora"] {', 'text'));
  });

  it('aurora 亮色：终端背景/前景 = DOM 的 --bg-app / --text', () => {
    expect(TERM_THEMES.aurora.light.background).toBe(cssVar('[data-theme-family="aurora"][data-theme="light"] {', 'bg-app'));
    expect(TERM_THEMES.aurora.light.foreground).toBe(cssVar('[data-theme-family="aurora"][data-theme="light"] {', 'text'));
  });

  it('aurora 选区色复用 accent（#6394ff）', () => {
    expect(TERM_THEMES.aurora.dark.selectionBackground).toContain('99, 148, 255');
    expect(TERM_THEMES.aurora.light.selectionBackground).toContain('74, 130, 232');
  });

  // ── Mineral 家族 ──
  it('mineral 暗色：终端背景/前景 = DOM 的 --bg-app / --text', () => {
    expect(TERM_THEMES.mineral.dark.background).toBe(cssVar('[data-theme-family="mineral"] {', 'bg-app'));
    expect(TERM_THEMES.mineral.dark.foreground).toBe(cssVar('[data-theme-family="mineral"] {', 'text'));
  });

  it('mineral 亮色：终端背景/前景 = DOM 的 --bg-app / --text', () => {
    expect(TERM_THEMES.mineral.light.background).toBe(cssVar('[data-theme-family="mineral"][data-theme="light"] {', 'bg-app'));
    expect(TERM_THEMES.mineral.light.foreground).toBe(cssVar('[data-theme-family="mineral"][data-theme="light"] {', 'text'));
  });

  it('mineral 选区色复用 accent（#2dd4bf）', () => {
    expect(TERM_THEMES.mineral.dark.selectionBackground).toContain('45, 212, 191');
    expect(TERM_THEMES.mineral.light.selectionBackground).toContain('13, 148, 136');
  });

  // ── 结构校验 ──
  it('覆盖三个家族且每个家族有 dark/light', () => {
    expect(Object.keys(TERM_THEMES).sort()).toEqual(['aurora', 'github', 'mineral']);
    expect(Object.keys(TERM_THEMES.github).sort()).toEqual(['dark', 'light']);
    expect(Object.keys(TERM_THEMES.aurora).sort()).toEqual(['dark', 'light']);
    expect(Object.keys(TERM_THEMES.mineral).sort()).toEqual(['dark', 'light']);
  });

  it('getTermTheme 返回与 TERM_THEMES 同构的对象', () => {
    expect(getTermTheme('github', 'dark')).toEqual(TERM_THEMES.github.dark);
    expect(getTermTheme('github', 'light')).toEqual(TERM_THEMES.github.light);
    expect(getTermTheme('aurora', 'dark')).toEqual(TERM_THEMES.aurora.dark);
    expect(getTermTheme('mineral', 'light')).toEqual(TERM_THEMES.mineral.light);
  });
});
