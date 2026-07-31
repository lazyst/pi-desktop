// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TERM_THEMES } from '../theme';

const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles/tokens.css'), 'utf-8');

// 抽取某主题块内某个 CSS 变量的值。
function cssVar(selector: string, name: string): string {
  const block = css.split(selector)[1]?.split('}')[0] ?? '';
  const m = block.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : '';
}

describe('TERM_THEMES 与 tokens.css 同源（由 theme.ts 委托导出）', () => {
  it('github 暗色：终端背景/前景 = DOM 的 --bg-app / --text', () => {
    expect(TERM_THEMES.github.dark.background).toBe(cssVar(':root {', 'bg-app'));
    expect(TERM_THEMES.github.dark.foreground).toBe(cssVar(':root {', 'text'));
  });

  it('github 亮色：终端背景/前景 = DOM 的 --bg-app / --text', () => {
    expect(TERM_THEMES.github.light.background).toBe(cssVar('[data-theme="light"] {', 'bg-app'));
    expect(TERM_THEMES.github.light.foreground).toBe(cssVar('[data-theme="light"] {', 'text'));
  });

  it('aurora 暗色：终端背景/前景 = DOM 的 --bg-app / --text', () => {
    expect(TERM_THEMES.aurora.dark.background).toBe(cssVar('[data-theme-family="aurora"] {', 'bg-app'));
    expect(TERM_THEMES.aurora.dark.foreground).toBe(cssVar('[data-theme-family="aurora"] {', 'text'));
  });

  it('aurora 亮色：终端背景/前景 = DOM 的 --bg-app / --text', () => {
    expect(TERM_THEMES.aurora.light.background).toBe(cssVar('[data-theme-family="aurora"][data-theme="light"] {', 'bg-app'));
    expect(TERM_THEMES.aurora.light.foreground).toBe(cssVar('[data-theme-family="aurora"][data-theme="light"] {', 'text'));
  });

  it('mineral 暗色：终端背景/前景 = DOM 的 --bg-app / --text', () => {
    expect(TERM_THEMES.mineral.dark.background).toBe(cssVar('[data-theme-family="mineral"] {', 'bg-app'));
    expect(TERM_THEMES.mineral.dark.foreground).toBe(cssVar('[data-theme-family="mineral"] {', 'text'));
  });

  it('mineral 亮色：终端背景/前景 = DOM 的 --bg-app / --text', () => {
    expect(TERM_THEMES.mineral.light.background).toBe(cssVar('[data-theme-family="mineral"][data-theme="light"] {', 'bg-app'));
    expect(TERM_THEMES.mineral.light.foreground).toBe(cssVar('[data-theme-family="mineral"][data-theme="light"] {', 'text'));
  });

  it('覆盖三个家族且每个家族有 dark/light', () => {
    expect(Object.keys(TERM_THEMES).sort()).toEqual(['aurora', 'github', 'mineral']);
  });
});
