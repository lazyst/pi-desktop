// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { SessionPane } from '../components/SessionPane';
import type { PiApi } from '../ipc';

// 用可控的 mock 替换 WebGL addon，验证壳在 active 挂载时会经 XtermTerminal 尝试启用 GPU
// 渲染器，且加载失败（无 WebGL）时静默回退（参照 VS Code _enableWebglRenderer 的 try/catch）。
const hoist = vi.hoisted(() => ({ webglThrow: false, activateCalls: 0 }));
vi.mock('@xterm/addon-webgl', () => {
  class WebglAddon {
    disposed = false;
    contextLossHandler: (() => void) | null = null;
    activate() {
      hoist.activateCalls++;
      if (hoist.webglThrow) throw new Error('WebGL unavailable');
    }
    onContextLoss(cb: () => void) {
      this.contextLossHandler = cb;
    }
    dispose() {
      this.disposed = true;
    }
  }
  return { WebglAddon };
});

function makeApi() {
  return {
    listSessions: vi.fn(), openSession: vi.fn(), terminate: vi.fn(),
    input: vi.fn(), resize: vi.fn(), onData: vi.fn(() => () => {}), onStatus: vi.fn(() => () => {}),
    onExit: vi.fn(), pickDirectory: vi.fn(), debug: vi.fn(),
  } as unknown as PiApi;
}

describe('SessionPane shell WebGL renderer', () => {
  beforeEach(() => {
    hoist.webglThrow = false;
    hoist.activateCalls = 0;
  });

  it('attempts to enable the WebGL (GPU) renderer when active (via XtermTerminal)', () => {
    const api = makeApi();
    (window as any).pi = api;
    render(<SessionPane sessionKey="k" active={true} />);
    expect(hoist.activateCalls).toBeGreaterThanOrEqual(1);
  });

  it('falls back to DOM renderer without throwing when WebGL is unavailable', () => {
    const api = makeApi();
    (window as any).pi = api;
    hoist.webglThrow = true;
    const { container } = render(<SessionPane sessionKey="k" active={true} />);
    expect(container.querySelector('.terminal-host')).toBeTruthy();
    expect(hoist.activateCalls).toBeGreaterThanOrEqual(1);
  });
});
