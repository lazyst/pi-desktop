// markdown 相对/外链解析纯函数测试（linkUtils 链接路由，见 grilling 会话）。
// 不依赖 React/CodeMirror，仅验证 isExternalHref 与 resolveRelativeLink 的判定与解析。
import { describe, it, expect } from 'vitest';
import { isExternalHref, resolveRelativeLink } from '../linkUtils';

describe('isExternalHref', () => {
  it('识别绝对外链协议（http/https/mailto）', () => {
    expect(isExternalHref('https://example.com/x')).toBe(true);
    expect(isExternalHref('http://example.com')).toBe(true);
    expect(isExternalHref('mailto:a@b.com')).toBe(true);
  });

  it('file: 不算外部（由 webview 隔离处理）', () => {
    expect(isExternalHref('file:///C:/x.md')).toBe(false);
  });

  it('相对链接不算外部（应走应用内跳转）', () => {
    expect(isExternalHref('./README.md')).toBe(false);
    expect(isExternalHref('../api/x.md')).toBe(false);
    expect(isExternalHref('README.md')).toBe(false);
  });

  it('javascript: 等危险协议被识别为「外部」→ 走 openExternal（不打应用内跳转）', () => {
    // 这类带 scheme 但非 file:，归为外部，由受控通道 openExternal 拒绝放行。
    expect(isExternalHref('javascript:alert(1)')).toBe(true);
  });
});

describe('resolveRelativeLink', () => {
  it('以当前文件目录为基准拼接相对链接', () => {
    expect(resolveRelativeLink('docs', './api.md')).toBe('docs/api.md');
    expect(resolveRelativeLink('docs/guide', 'intro.md')).toBe('docs/guide/intro.md');
  });

  it('处理上一级目录（..）：原样保留交给主进程 fsBridge 解析', () => {
    // 渲染层不做 parent-walk，../ 原样保留；nodePath.resolve + 越界校验在后端完成。
    expect(resolveRelativeLink('docs', '../README.md')).toBe('docs/../README.md');
  });

  it('baseDir 为空时去掉 ./ 前缀返回（根目录文件）', () => {
    expect(resolveRelativeLink('', './README.md')).toBe('README.md');
  });

  it('裁剪多余分隔符', () => {
    expect(resolveRelativeLink('docs/', '/api.md')).toBe('docs/api.md');
  });
});
