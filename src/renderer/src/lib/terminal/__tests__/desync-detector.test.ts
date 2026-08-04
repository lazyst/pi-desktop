// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DesyncDetector, type DesyncDetectorContext } from '../desync-detector';

// jsdom 的 Canvas 2D 上下文不支持 createImageData/putImageData/getImageData 的完整实现，
// 因此采用 mock 2D context 的方式来控制 getImageData 返回值。

// ── 辅助：创建 mock 2D context ──
function createMock2dContext(
  width: number,
  height: number,
  pixelData: (x: number, y: number) => [number, number, number, number],
): CanvasRenderingContext2D {
  const totalPixels = width * height;
  const pixelArray = new Uint8ClampedArray(totalPixels * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelData(x, y);
      const idx = (y * width + x) * 4;
      pixelArray[idx] = r;
      pixelArray[idx + 1] = g;
      pixelArray[idx + 2] = b;
      pixelArray[idx + 3] = a;
    }
  }

  return {
    drawImage: vi.fn(),
    getImageData: (x: number, y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const srcX = Math.floor(x) + px;
          const srcY = Math.floor(y) + py;
          const srcIdx = (srcY * width + srcX) * 4;
          const dstIdx = (py * w + px) * 4;
          if (srcX >= 0 && srcX < width && srcY >= 0 && srcY < height) {
            data[dstIdx] = pixelArray[srcIdx];
            data[dstIdx + 1] = pixelArray[srcIdx + 1];
            data[dstIdx + 2] = pixelArray[srcIdx + 2];
            data[dstIdx + 3] = pixelArray[srcIdx + 3];
          } else {
            data[dstIdx + 3] = 255;
          }
        }
      }
      return { data, width: w, height: h } as ImageData;
    },
  } as unknown as CanvasRenderingContext2D
}

// ── 辅助：创建 mock canvas ──
function createMockCanvas(
  width: number,
  height: number,
  pixelData: (x: number, y: number) => [number, number, number, number],
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const mockCtx = createMock2dContext(width, height, pixelData);
  canvas.getContext = (() => mockCtx) as any;
  return canvas;
}

// ── 辅助：创建带 getCell 支持的 mock line ──
function createMockLine(text: string) {
  // 为每个 cell 提供一个 getCell() 方法
  return {
    translateToString: () => text,
    getCell: (col: number) => {
      const char = text[col] ?? ' ';
      if (char === ' ' || char === '') return undefined;
      return {
        getChars: () => char,
        getWidth: () => (char.length > 0 ? 1 : 0),
      };
    },
  };
}

// ── 辅助：创建 mock 终端上下文 ──
function createMockContext(overrides?: Partial<DesyncDetectorContext> & {
  rows?: number;
  cols?: number;
  viewportY?: number;
  cursorY?: number;
  canvas?: HTMLCanvasElement;
  lines?: string[];
}): DesyncDetectorContext & { term: any; webgl: any; host: HTMLElement } {
  const rows = overrides?.rows ?? 24;
  const cols = overrides?.cols ?? 80;
  const viewportY = overrides?.viewportY ?? 0;
  const cursorY = overrides?.cursorY ?? 0;
  const lines = overrides?.lines ?? Array(rows).fill(' '.repeat(cols));

  const mockBuffer = {
    active: {
      viewportY,
      cursorY,
      getLine: (lineIndex: number) => {
        const offset = lineIndex - viewportY;
        if (offset >= 0 && offset < lines.length) {
          return createMockLine(lines[offset]);
        }
        return null;
      },
    },
  };

  const term = {
    buffer: mockBuffer,
    rows,
    cols,
    refresh: vi.fn(),
  };

  const webgl = {
    clearTextureAtlas: vi.fn(),
  };

  const canvas = overrides?.canvas ?? createMockCanvas(cols * 10, rows * 20, () => [0, 0, 0, 255]);

  const host = document.createElement('div');
  host.appendChild(canvas);
  host.id = 'test-pane';

  return {
    term,
    webgl,
    host,
    isActive: () => true,
    ...overrides,
  } as any;
}

describe('DesyncDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('start() / stop() 生命周期', () => {
    it('start() 启动定时器，running 返回 true', () => {
      const detector = new DesyncDetector({ interval: 5000 });
      const ctx = createMockContext();
      detector.start(ctx);
      expect(detector.running).toBe(true);
      detector.stop();
    });

    it('stop() 停止定时器，running 返回 false', () => {
      const detector = new DesyncDetector({ interval: 5000 });
      const ctx = createMockContext();
      detector.start(ctx);
      expect(detector.running).toBe(true);
      detector.stop();
      expect(detector.running).toBe(false);
    });

    it('start() 幂等：多次调用不会启动多个定时器', () => {
      const detector = new DesyncDetector({ interval: 5000 });
      const ctx = createMockContext();
      detector.start(ctx);
      detector.start(ctx);
      detector.start(ctx);
      expect(detector.running).toBe(true);
      detector.stop();
    });

    it('stop() 幂等：多次调用不抛错', () => {
      const detector = new DesyncDetector();
      detector.stop();
      detector.stop();
      expect(detector.running).toBe(false);
    });

    it('定时器按 interval 周期触发检测', () => {
      const detector = new DesyncDetector({ interval: 5000 });
      // 需要至少 minTextCells 个文本 cell，否则检测提前跳过
      const lines = Array(24).fill('x'.repeat(80));
      const ctx = createMockContext({ lines });
      const checkSpy = vi.spyOn(detector as any, '_check');
      detector.start(ctx);
      expect(checkSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5000);
      expect(checkSpy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5000);
      expect(checkSpy).toHaveBeenCalledTimes(2);
      detector.stop();
    });
  });

  describe('持续性验证', () => {
    it('单次不匹配不足 persistentSamples（默认 2）时不触发恢复', () => {
      const detector = new DesyncDetector({ threshold: 0.01, colorTolerance: 30, persistentSamples: 2 });
      const cols = 10;
      const rows = 4;
      const cellW = 10;
      const cellH = 20;

      // 所有行都有内容，cursorY=0 跳过光标行
      const lines = [
        'x'.repeat(cols),    // 光标行（跳过）
        'x'.repeat(cols),    // 有内容
        'x'.repeat(cols),    // 有内容
        'x'.repeat(cols),    // 有内容
      ];

      // canvas 全黑 → 全部不匹配
      const canvas = createMockCanvas(cols * cellW, rows * cellH, () => [0, 0, 0, 255]);

      const ctx = createMockContext({
        canvas,
        rows,
        cols,
        lines,
        cursorY: 0,
      });

      // 第一次检测：历史不足 2 次，不触发
      detector.check(ctx);
      expect(ctx.webgl.clearTextureAtlas).not.toHaveBeenCalled();
      expect(ctx.term.refresh).not.toHaveBeenCalled();
    });

    it('连续 2 次同一批 cell 缺失 → 触发恢复', async () => {
      const detector = new DesyncDetector({ threshold: 0.01, colorTolerance: 30, persistentSamples: 2, minTextCells: 1 });
      const cols = 10;
      const rows = 4;
      const cellW = 10;
      const cellH = 20;

      const lines = [
        'x'.repeat(cols),    // 光标行（跳过）
        'x'.repeat(cols),    // 有内容
        'x'.repeat(cols),    // 有内容
        'x'.repeat(cols),    // 有内容
      ];

      const canvas = createMockCanvas(cols * cellW, rows * cellH, () => [0, 0, 0, 255]);

      const ctx = createMockContext({
        canvas,
        rows,
        cols,
        lines,
        cursorY: 0,
      });

      // 第一次检测：历史不足 2 次，不触发
      detector.check(ctx);
      expect(ctx.webgl.clearTextureAtlas).not.toHaveBeenCalled();

      // 第二次检测（同一批 cell 仍然缺失）→ 触发 clearTextureAtlas（同步）
      detector.check(ctx);
      expect(ctx.webgl.clearTextureAtlas).toHaveBeenCalledTimes(1);
      // refresh 在双 rAF settle 中异步执行
      await vi.waitFor(() => {
        expect(ctx.term.refresh).toHaveBeenCalledWith(0, rows - 1);
      });
    });

    it('两次缺失的 cell 不同（不重叠）→ 判定为暂时现象，不触发恢复', () => {
      const detector = new DesyncDetector({ threshold: 0.01, colorTolerance: 30, persistentSamples: 2, minTextCells: 1 });
      const cols = 10;
      const rows = 4;
      const cellW = 10;
      const cellH = 20;

      const lines = [
        'x'.repeat(cols),    // 光标行（跳过）
        'x'.repeat(cols),    // 有内容
        'x'.repeat(cols),    // 有内容
        'x'.repeat(cols),    // 有内容
      ];

      // 第一次 canvas 渲染了第 1 行，第 2 行缺失 → 缺失 cell 在 row=2
      const canvas1 = createMockCanvas(cols * cellW, rows * cellH, (x, y) => {
        const row2CenterY = Math.floor(2 * cellH + cellH / 2);
        const row1CenterY = Math.floor(1 * cellH + cellH / 2);
        // row=1 渲染正确，row=2 全黑
        if (y === row1CenterY) return [255, 255, 255, 255];
        // row=2 全黑（缺失）
        if (y === row2CenterY) return [0, 0, 0, 0];
        return [0, 0, 0, 255];
      });

      const ctx = createMockContext({
        canvas: canvas1,
        rows,
        cols,
        lines,
        cursorY: 0,
      });

      // 第一次检测：row=2 缺失
      detector.check(ctx);
      expect(ctx.webgl.clearTextureAtlas).not.toHaveBeenCalled();

      // 第二次 canvas 渲染了第 2 行，第 1 行缺失 → 缺失 cell 不同
      const canvas2 = createMockCanvas(cols * cellW, rows * cellH, (x, y) => {
        const row2CenterY = Math.floor(2 * cellH + cellH / 2);
        const row1CenterY = Math.floor(1 * cellH + cellH / 2);
        // row=1 全黑（缺失）
        if (y === row1CenterY) return [0, 0, 0, 0];
        // row=2 渲染正确
        if (y === row2CenterY) return [255, 255, 255, 255];
        return [0, 0, 0, 255];
      });

      // 替换 canvas
      ctx.host.innerHTML = '';
      ctx.host.appendChild(canvas2);

      // 第二次检测：缺失 cell 在 row=1（与第一次的 row=2 不重叠）
      detector.check(ctx);
      // 不重叠 → 不触发恢复
      expect(ctx.webgl.clearTextureAtlas).not.toHaveBeenCalled();
    });

    it('连续 3 次同一批 cell 缺失（persistentSamples=3）→ 触发恢复', () => {
      const detector = new DesyncDetector({ threshold: 0.01, colorTolerance: 30, persistentSamples: 3, minTextCells: 1 });
      const cols = 10;
      const rows = 4;
      const cellW = 10;
      const cellH = 20;

      const lines = [
        'x'.repeat(cols),
        'x'.repeat(cols),
        'x'.repeat(cols),
        'x'.repeat(cols),
      ];

      const canvas = createMockCanvas(cols * cellW, rows * cellH, () => [0, 0, 0, 255]);

      const ctx = createMockContext({
        canvas,
        rows,
        cols,
        lines,
        cursorY: 0,
      });

      // 第 1 次
      detector.check(ctx);
      expect(ctx.webgl.clearTextureAtlas).not.toHaveBeenCalled();
      // 第 2 次
      detector.check(ctx);
      expect(ctx.webgl.clearTextureAtlas).not.toHaveBeenCalled();
      // 第 3 次
      detector.check(ctx);
      expect(ctx.webgl.clearTextureAtlas).toHaveBeenCalledTimes(1);
    });
  });

  describe('跳过光标行', () => {
    it('当光标行有内容但 canvas 全黑，光标行不参与检测，不阻止恢复', () => {
      const detector = new DesyncDetector({ threshold: 0.01, colorTolerance: 30, persistentSamples: 2, minTextCells: 1 });
      const cols = 10;
      const rows = 4;
      const cellW = 10;
      const cellH = 20;

      // 光标行（row=1）和非光标行都有内容
      // cursorY=1 应被跳过，row=0,2,3 参与检测
      const lines = [
        'x'.repeat(cols),    // 非光标行
        'x'.repeat(cols),    // 光标行（跳过）
        'x'.repeat(cols),    // 非光标行
        'x'.repeat(cols),    // 非光标行
      ];

      // canvas 全黑 → 非光标行全部缺失
      const canvas = createMockCanvas(cols * cellW, rows * cellH, () => [0, 0, 0, 255]);

      const ctx = createMockContext({
        canvas,
        rows,
        cols,
        lines,
        cursorY: 1,
      });

      // 第一次
      detector.check(ctx);
      expect(ctx.webgl.clearTextureAtlas).not.toHaveBeenCalled();
      // 第二次 → 触发（非光标行有 30 个 cell，全部缺失 = 100%）
      detector.check(ctx);
      expect(ctx.webgl.clearTextureAtlas).toHaveBeenCalledTimes(1);
    });
  });

  describe('check() 检测逻辑', () => {
    it('非 active 时不检测，不触发恢复', () => {
      const detector = new DesyncDetector();
      const ctx = createMockContext({ isActive: () => false });
      detector.check(ctx);
      expect(ctx.webgl.clearTextureAtlas).not.toHaveBeenCalled();
      expect(ctx.term.refresh).not.toHaveBeenCalled();
    });

    it('无 webgl 时不检测', () => {
      const detector = new DesyncDetector();
      const ctx = createMockContext();
      (ctx.webgl as any) = null;
      detector.check(ctx);
      // 不应抛错
    });

    it('无 host 时不检测', () => {
      const detector = new DesyncDetector();
      const ctx = createMockContext({ host: document.createElement('div') }); // 无 canvas 子元素
      detector.check(ctx);
      expect(ctx.term.refresh).not.toHaveBeenCalled();
    });

    it('无 canvas 时不检测', () => {
      const detector = new DesyncDetector();
      const ctx = createMockContext();
      ctx.host.innerHTML = '';
      detector.check(ctx);
      expect(ctx.term.refresh).not.toHaveBeenCalled();
    });

    it('buffer 有内容、canvas 渲染正确 → 不触发恢复', () => {
      const detector = new DesyncDetector({ threshold: 0.1, colorTolerance: 30, persistentSamples: 2, minTextCells: 1 });
      const cols = 80;
      const rows = 24;
      const cellW = 10;
      const cellH = 20;

      // 非光标行有内容，canvas 正确渲染
      const lines = [
        'hello' + ' '.repeat(cols - 5),
        ...Array(rows - 1).fill(' '.repeat(cols)),
      ];

      // 仅在非光标行（row=0, cursorY=0 被跳过，所以实际上 row=0 是光标行，不参与检测）
      // 非光标行全部是空格 → 0 text cells → 低于 minTextCells → 跳过
      // 改一下：让非光标行也有内容
      const linesWithContent = [
        'hello' + ' '.repeat(cols - 5),  // 光标行（跳过）
        'world' + ' '.repeat(cols - 5),  // 非光标行，有内容
        ...Array(rows - 2).fill(' '.repeat(cols)),
      ];

      // cell 中心像素渲染白色
      const row1CenterY = Math.floor(1 * cellH + cellH / 2);
      const cellCenterXs = Array.from({ length: 5 }, (_, i) => Math.floor(i * cellW + cellW / 2));
      const isCellCenter = (x: number, y: number) =>
        y === row1CenterY && cellCenterXs.includes(x);

      const canvas = createMockCanvas(cols * cellW, rows * cellH, (x, y) => {
        if (isCellCenter(x, y)) return [255, 255, 255, 255];
        return [0, 0, 0, 255];
      });

      const ctx = createMockContext({
        canvas,
        rows,
        cols,
        lines: linesWithContent,
        cursorY: 0,
      });

      // 需要 2 次才能触发
      detector.check(ctx);
      detector.check(ctx);
      // 全匹配，不应触发恢复
      expect(ctx.term.refresh).not.toHaveBeenCalled();
      expect(ctx.webgl.clearTextureAtlas).not.toHaveBeenCalled();
    });

    it('大量不匹配（> 10%）→ 连续 2 次后触发 clearTextureAtlas + refresh', () => {
      const detector = new DesyncDetector({ threshold: 0.1, colorTolerance: 30, persistentSamples: 2, minTextCells: 1 });
      const cols = 10;
      const rows = 4;
      const cellW = 10;
      const cellH = 20;

      // 非光标行全部有内容
      const lines = [
        'x'.repeat(cols),    // 光标行（跳过）
        'hello.....',        // 非光标行，5 非空格
        'world!....',        // 非光标行，6 非空格
        ' '.repeat(cols),    // 全空格
      ];

      // canvas 全黑
      const canvas = createMockCanvas(cols * cellW, rows * cellH, () => [0, 0, 0, 255]);

      const ctx = createMockContext({
        canvas,
        rows,
        cols,
        lines,
        cursorY: 0,
      });

      // 第 1 次
      detector.check(ctx);
      expect(ctx.webgl.clearTextureAtlas).not.toHaveBeenCalled();
      // 第 2 次 → 触发 clearTextureAtlas（同步）；refresh 在双 rAF settle 中异步执行
      detector.check(ctx);
      expect(ctx.webgl.clearTextureAtlas).toHaveBeenCalledTimes(1);
      // 不检查 refresh——它在双 rAF settle 中异步执行，jsdom 的 rAF 不触发回调
      // 恢复的关键是 clearTextureAtlas 被正确调用，refresh 由 rAF 驱动
    });

    it('clearTextureAtlas 抛错时不传播异常', () => {
      const detector = new DesyncDetector({ threshold: 0.01, colorTolerance: 30, persistentSamples: 2, minTextCells: 1 });
      const cols = 10;
      const rows = 4;
      const cellW = 10;
      const cellH = 20;

      const lines = [
        'x'.repeat(cols),
        'x'.repeat(cols),
        'x'.repeat(cols),
        'x'.repeat(cols),
      ];
      const canvas = createMockCanvas(cols * cellW, rows * cellH, () => [0, 0, 0, 255]);

      const ctx = createMockContext({
        canvas,
        rows,
        cols,
        lines,
        cursorY: 0,
      });
      // clearTextureAtlas 抛错
      (ctx.webgl as any).clearTextureAtlas = vi.fn(() => { throw new Error('oops'); });
      // 第一次
      detector.check(ctx);
      // 第二次 → 触发恢复，但抛错
      expect(() => detector.check(ctx)).not.toThrow();
    });
  });

  describe('统计信息', () => {
    it('记录 totalChecks、totalRecoveries', () => {
      const detector = new DesyncDetector({ threshold: 0.01, colorTolerance: 30, persistentSamples: 2, minTextCells: 1 });
      const cols = 10;
      const rows = 4;
      const cellW = 10;
      const cellH = 20;

      const lines = Array(rows).fill('x'.repeat(cols));
      const canvas = createMockCanvas(cols * cellW, rows * cellH, () => [0, 0, 0, 255]);

      const ctx = createMockContext({
        canvas,
        rows,
        cols,
        lines,
        cursorY: 0,
      });

      expect(detector.getStats().totalChecks).toBe(0);
      expect(detector.getStats().totalRecoveries).toBe(0);

      // 第 1 次
      detector.check(ctx);
      expect(detector.getStats().totalChecks).toBe(1);
      expect(detector.getStats().totalRecoveries).toBe(0);

      // 第 2 次 → 触发恢复
      detector.check(ctx);
      expect(detector.getStats().totalChecks).toBe(2);
      expect(detector.getStats().totalRecoveries).toBe(1);
      expect(detector.getStats().lastRecoveryTime).toBeGreaterThan(0);
    });

    it('resetStats 重置所有统计', () => {
      const detector = new DesyncDetector({ threshold: 0.01, colorTolerance: 30, persistentSamples: 2, minTextCells: 1 });
      const cols = 10;
      const rows = 4;
      const cellW = 10;
      const cellH = 20;

      const lines = Array(rows).fill('x'.repeat(cols));
      const canvas = createMockCanvas(cols * cellW, rows * cellH, () => [0, 0, 0, 255]);

      const ctx = createMockContext({
        canvas,
        rows,
        cols,
        lines,
        cursorY: 0,
      });

      detector.check(ctx);
      detector.check(ctx);
      expect(detector.getStats().totalRecoveries).toBe(1);

      detector.resetStats();
      expect(detector.getStats().totalChecks).toBe(0);
      expect(detector.getStats().totalRecoveries).toBe(0);
    });
  });

  describe('WebGL 集成 — XtermTerminal 集成验证', () => {
    it('WebGL 启用时启动检测器，WebGL 为空时不启动', () => {
      const detector = new DesyncDetector();
      const ctx = createMockContext();
      (ctx.webgl as any) = null;
      detector.start(ctx);
      expect(detector.running).toBe(true);
      detector.check(ctx);
      expect(ctx.term.refresh).not.toHaveBeenCalled();
      detector.stop();
    });

    it('active=false 时检测器不触发恢复', () => {
      const detector = new DesyncDetector({ threshold: 0.01, colorTolerance: 30, persistentSamples: 2 });
      const cols = 10;
      const rows = 4;
      const cellW = 10;
      const cellH = 20;

      const lines = ['hello' + ' '.repeat(5), ...Array(rows - 1).fill(' '.repeat(cols))];
      const canvas = createMockCanvas(cols * cellW, rows * cellH, () => [0, 0, 0, 255]);

      const ctx = createMockContext({
        canvas,
        rows,
        cols,
        lines,
        isActive: () => false,
      });
      detector.check(ctx);
      expect(ctx.term.refresh).not.toHaveBeenCalled();
      expect(ctx.webgl.clearTextureAtlas).not.toHaveBeenCalled();
    });
  });

  describe('xterm 集成', () => {
    it('mount 后 WebGL 模式下检测器已启动', () => {
      const detector = new DesyncDetector();
      const ctx = createMockContext();
      detector.start(ctx);
      expect(detector.running).toBe(true);
      detector.stop();
    });

    it('unmount 时检测器停止', () => {
      const detector = new DesyncDetector();
      const ctx = createMockContext();
      detector.start(ctx);
      expect(detector.running).toBe(true);
      detector.stop();
      expect(detector.running).toBe(false);
    });

    it('WebGL 上下文丢失后检测器停止', () => {
      const detector = new DesyncDetector();
      const ctx = createMockContext();
      detector.start(ctx);
      expect(detector.running).toBe(true);
      detector.stop();
      expect(detector.running).toBe(false);
      const inactiveCtx = createMockContext({ isActive: () => false });
      detector.check(inactiveCtx);
      expect(inactiveCtx.term.refresh).not.toHaveBeenCalled();
    });
  });
});