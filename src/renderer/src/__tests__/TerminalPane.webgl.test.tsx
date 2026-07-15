// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { TerminalPane } from '../components/TerminalPane';

// 用可控的 mock 替换 WebGL addon，验证 TerminalPane 在 open() 后会尝试启用 GPU 渲染器，
// 且加载失败（无 WebGL）时静默回退到内建 DOM 渲染器（参照 VS Code _enableWebglRenderer 的 try/catch 回退）。
// 注：xterm 6.0.0 已移除 canvas 渲染器，故仅 WebGL→DOM 两级回退。
const hoist = vi.hoisted(() => ({ webglThrow: false, activateCalls: 0 }));
vi.mock('@xterm/addon-webgl', () => {
  class WebglAddon {
    disposed = false;
    contextLossHandler: (() => void) | null = null;
    activate() {
      hoist.activateCalls++;
      if (hoist.webglThrow) throw new Error('WebGL unavailable');
    }
    onContextLoss(cb: () => void) { this.contextLossHandler = cb; }
    dispose() { this.disposed = true; }
  }
  return { WebglAddon };
});

function makeApi() {
  return {
    listSessions: vi.fn(), openSession: vi.fn(), terminate: vi.fn(),
    input: vi.fn(), resize: vi.fn(), onData: vi.fn(), onStatus: vi.fn(), onExit: vi.fn(),
    pickDirectory: vi.fn(), debug: vi.fn(),
  };
}

describe('TerminalPane WebGL renderer', () => {
  beforeEach(() => {
    hoist.webglThrow = false;
    hoist.activateCalls = 0;
  });

  it('attempts to enable the WebGL (GPU) renderer after opening', () => {
    const api = makeApi();
    (window as any).pi = api;
    render(<TerminalPane sessionKey="k" active={true} />);
    // enableWebgl() runs in the active effect → term.loadAddon(webglAddon) → mock.activate()
    expect(hoist.activateCalls).toBeGreaterThanOrEqual(1);
  });

  it('falls back to the DOM renderer without throwing when WebGL is unavailable', () => {
    const api = makeApi();
    (window as any).pi = api;
    hoist.webglThrow = true;
    // 不应抛出；组件照常渲染，DOM 渲染器兜底。
    const { container } = render(<TerminalPane sessionKey="k" active={true} />);
    expect(container.querySelector('.terminal-host')).toBeTruthy();
    expect(hoist.activateCalls).toBeGreaterThanOrEqual(1);
  });
});
