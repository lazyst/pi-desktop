// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TERM_THEMES, getTermTheme } from '../terminal-themes';

const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles/tokens.css'), 'utf-8');

// 抽取某主题块内某个 CSS 变量的值（:root = 暗色；[data-theme="light"] = 亮色）。
function cssVar(selector: string, name: string): string {
  const block = css.split(selector)[1]?.split('}')[0] ?? '';
  const m = block.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : '';
}

describe('terminal-themes 与 tokens.css 同源（从独立模块导出）', () => {
  it('暗色：终端背景/前景 = DOM 的 --bg-app / --text', () => {
    expect(TERM_THEMES.dark.background).toBe(cssVar(':root {', 'bg-app'));
    expect(TERM_THEMES.dark.foreground).toBe(cssVar(':root {', 'text'));
  });

  it('亮色：终端背景/前景 = DOM 的 --bg-app / --text', () => {
    expect(TERM_THEMES.light.background).toBe(cssVar('[data-theme="light"] {', 'bg-app'));
    expect(TERM_THEMES.light.foreground).toBe(cssVar('[data-theme="light"] {', 'text'));
  });

  it('选区色复用各自主题的 accent（冷静蓝签名）', () => {
    // --accent 暗色 #7c9cff = rgb(124, 156, 255)；亮色 #3b5bdb = rgb(59, 91, 219)
    expect(TERM_THEMES.dark.selectionBackground).toContain('124, 156, 255');
    expect(TERM_THEMES.light.selectionBackground).toContain('59, 91, 219');
  });

  it('覆盖两套主题且键与 Theme 一致', () => {
    expect(Object.keys(TERM_THEMES).sort()).toEqual(['dark', 'light']);
  });

  it('getTermTheme 返回与 TERM_THEMES 同构的对象', () => {
    expect(getTermTheme('dark')).toEqual(TERM_THEMES.dark);
    expect(getTermTheme('light')).toEqual(TERM_THEMES.light);
    expect(getTermTheme('dark')).not.toBe(getTermTheme('light'));
  });
});
