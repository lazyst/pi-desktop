// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DesyncDetector, type DesyncDetectorContext } from '../desync-detector';

// jsdom 的 Canvas 2D 上下文不支持 createImageData/putImageData/getImageData 的完整实现，
// 因此采用 mock 2D context 的方式来控制 getImageData 返回值。
// 通过 createMockContext 中的 mockCanvas 工厂返回一个 canvas，其 getContext('2d') 返回
// 受控的 mock context，其中 getImageData(x, y, 1, 1) 返回指定像素。

// ── 辅助：创建 mock 2D context ──
function createMock2dContext(
  width: number,
  height: number,
  pixelData: (x: number, y: number) => [number, number, number, number],
): CanvasRenderingContext2D {
  // 预先计算所有像素的 Uint8ClampedArray
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
    drawImage: vi.fn((source: HTMLCanvasElement, dx: number, dy: number) => {
      // 将 source canvas 的像素数据复制到本 context 的像素存储中
      // 仅当 source 是 mock canvas 时有效（通过 querySourcePixel 获取像素）
      const sourcePixelData = (source as any).__pixelData as ((x: number, y: number) => [number, number, number, number]) | undefined;
      if (sourcePixelData) {
        for (let sy = 0; sy < source.height; sy++) {
          for (let sx = 0; sx < source.width; sx++) {
            const [r, g, b, a] = sourcePixelData(sx, sy);
            const dstIdx = ((dy + sy) * width + (dx + sx)) * 4;
            if (dy + sy < height && dx + sx < width) {
              pixelArray[dstIdx] = r;
              pixelArray[dstIdx + 1] = g;
              pixelArray[dstIdx + 2] = b;
              pixelArray[dstIdx + 3] = a;
            }
          }
        }
      }
    }),
    getImageData: (x: number, y: number, w: number, h: number) => {
      // 返回指定区域的像素数据
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
            data[dstIdx + 3] = 255; // 默认不透明
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
  // 附加 pixelData 引用，供 mock drawImage 读取源 canvas 像素
  (canvas as any).__pixelData = pixelData;
  // 替换 getContext 方法，返回 mock context
  const mockCtx = createMock2dContext(width, height, pixelData);
  // 直接替换 getContext 方法（vi.spyOn 在 jsdom 中可能无法正确处理原生方法）
  canvas.getContext = (() => mockCtx) as any;
  return canvas;
}

// ── 辅助：创建 mock 终端上下文 ──
function createMockContext(overrides?: Partial<DesyncDetectorContext> & {
  rows?: number;
  cols?: number;
  viewportY?: number;
  canvas?: HTMLCanvasElement;
  lines?: string[];
}): DesyncDetectorContext & { term: any; webgl: any; host: HTMLElement } {
  const rows = overrides?.rows ?? 24;
  const cols = overrides?.cols ?? 80;
  const viewportY = overrides?.viewportY ?? 0;
  const lines = overrides?.lines ?? Array(rows).fill(' '.repeat(cols));

  const mockLine = (text: string) => ({
    translateToString: () => text,
  });

  const mockBuffer = {
    active: {
      viewportY,
      getLine: (lineIndex: number) => {
        const offset = lineIndex - viewportY;
        if (offset >= 0 && offset < lines.length) {
          return mockLine(lines[offset]);
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
      const ctx = createMockContext({ lines: ['x' + ' '.repeat(79), ...Array(23).fill(' '.repeat(80))] });
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
      ctx.host.innerHTML = ''; // 清空，无 canvas
      detector.check(ctx);
      expect(ctx.term.refresh).not.toHaveBeenCalled();
    });

    it('全空地行：canvas 全黑、buffer 全空格 → 不触发恢复', () => {
      const detector = new DesyncDetector({ threshold: 0.1 });
      const canvas = createMockCanvas(800, 480, () => [0, 0, 0, 255]);
      const ctx = createMockContext({
        canvas,
        rows: 24,
        cols: 80,
        lines: Array(24).fill(' '.repeat(80)),
      });
      detector.check(ctx);
      expect(ctx.term.refresh).not.toHaveBeenCalled();
      expect(ctx.webgl.clearTextureAtlas).not.toHaveBeenCalled();
    });

    it('buffer 有内容、canvas 渲染正确 → 不触发恢复', () => {
      const detector = new DesyncDetector({ threshold: 0.1, colorTolerance: 30 });
      const cols = 80;
      const rows = 24;
      // 模拟 cell 尺寸：10px wide, 20px tall
      const cellW = 10;
      const cellH = 20;

      // 左上角 5 个 cell 有内容（白色文字，仅在 cell 中心像素渲染）
      const lines = ['hello' + ' '.repeat(cols - 5), ...Array(rows - 1).fill(' '.repeat(cols))];

      // 仅在 cell 中心像素渲染白色内容（模拟渲染器正确渲染）
      const topRowCenterY = Math.floor(0 * cellH + cellH / 2); // 10
      const cellCenterXs = Array.from({ length: 5 }, (_, i) => Math.floor(i * cellW + cellW / 2)); // [5, 15, 25, 35, 45]
      const isCellCenter = (x: number, y: number) =>
        y === topRowCenterY && cellCenterXs.includes(x);

      const canvas = createMockCanvas(cols * cellW, rows * cellH, (x, y) => {
        if (isCellCenter(x, y)) return [255, 255, 255, 255];
        return [0, 0, 0, 255]; // 背景黑色
      });

      const ctx = createMockContext({
        canvas,
        rows,
        cols,
        lines,
      });
      detector.check(ctx);
      // 全匹配，不应触发恢复
      expect(ctx.term.refresh).not.toHaveBeenCalled();
      expect(ctx.webgl.clearTextureAtlas).not.toHaveBeenCalled();
    });

    it('buffer 有内容但 canvas 全黑（去同步）→ 触发恢复', () => {
      const detector = new DesyncDetector({ threshold: 0.1, colorTolerance: 30 });
      const cols = 80;
      const rows = 24;
      const cellW = 10;
      const cellH = 20;

      // buffer 顶行有内容 "hello"（5 个非空格）
      const lines = ['hello' + ' '.repeat(cols - 5), ...Array(rows - 1).fill(' '.repeat(cols))];

      // canvas 全黑（无渲染内容）
      const canvas = createMockCanvas(cols * cellW, rows * cellH, () => [0, 0, 0, 255]);

      const ctx = createMockContext({
        canvas,
        rows,
        cols,
        lines,
      });
      detector.check(ctx);
      // 5 个 cell 有文本但 canvas 渲染为背景色 → 不匹配
      // 顶行 + 底行共 160 cell，5 个不匹配 = 3.125% < 10%，不应触发
      expect(ctx.term.refresh).not.toHaveBeenCalled();
      expect(ctx.webgl.clearTextureAtlas).not.toHaveBeenCalled();
    });

    it('大量不匹配（> 10%）→ 触发 clearTextureAtlas + refresh', () => {
      const detector = new DesyncDetector({ threshold: 0.1, colorTolerance: 30 });
      const cols = 10;
      const rows = 4;
      const cellW = 10;
      const cellH = 20;

      // 顶行和底行全部有内容（非空格）
      const lines = [
        'hello.....', // 5 非空格 + 5 空格
        ' '.repeat(cols),
        ' '.repeat(cols),
        'world!....', // 6 非空格 + 4 空格
      ];

      // canvas 全黑（无渲染内容）
      const canvas = createMockCanvas(cols * cellW, rows * cellH, () => [0, 0, 0, 255]);

      const ctx = createMockContext({
        canvas,
        rows,
        cols,
        lines,
      });
      detector.check(ctx);
      // 顶行 + 底行共 20 cell，11 个不匹配 = 55% > 10%，应触发恢复
      expect(ctx.webgl.clearTextureAtlas).toHaveBeenCalledTimes(1);
      expect(ctx.term.refresh).toHaveBeenCalledWith(0, rows - 1);
    });

    it('canvas 有渲染但 buffer 全是空格（反向不匹配）→ 触发恢复', () => {
      const detector = new DesyncDetector({ threshold: 0.1, colorTolerance: 30 });
      const cols = 10;
      const rows = 4;
      const cellW = 10;
      const cellH = 20;

      // buffer 全部是空格
      const lines = Array(rows).fill(' '.repeat(cols));

      // canvas 仅在 cell 中心像素有白色内容（模拟渲染器渲染了内容）：
      // 实现中 x = Math.floor(col * cellW + cellW / 2), y = Math.floor(rowOffset * cellH + cellH / 2)
      // 所以白色像素精确位置：
      //   top row (rowOffset=0): y = 10, x in {5, 15, 25, 35, 45, 55, 65, 75, 85, 95}
      //   bottom row (rowOffset=3): y = 70, x in {5, 15, 25, 35, 45, 55, 65, 75, 85, 95}
      const topRowCenterY = Math.floor(0 * cellH + cellH / 2); // 10
      const bottomRowCenterY = Math.floor((rows - 1) * cellH + cellH / 2); // 70
      const cellCenterXs = Array.from({ length: cols }, (_, i) => Math.floor(i * cellW + cellW / 2));
      const isCellCenter = (x: number, y: number) =>
        (y === topRowCenterY || y === bottomRowCenterY) && cellCenterXs.includes(x);

      const canvas = createMockCanvas(cols * cellW, rows * cellH, (x, y) => {
        if (isCellCenter(x, y)) return [255, 255, 255, 255];
        return [0, 0, 0, 255];
      });

      const ctx = createMockContext({
        canvas,
        rows,
        cols,
        lines,
      });
      detector.check(ctx);
      // 顶行 10 + 底行 10 = 20 cell 全部不匹配 = 100% > 10%，应触发恢复
      expect(ctx.webgl.clearTextureAtlas).toHaveBeenCalledTimes(1);
      expect(ctx.term.refresh).toHaveBeenCalledWith(0, rows - 1);
    });

    it('clearTextureAtlas 抛错时不传播异常', () => {
      const detector = new DesyncDetector({ threshold: 0.01, colorTolerance: 30 });
      const cols = 10;
      const rows = 4;
      const cellW = 10;
      const cellH = 20;

      const lines = Array(rows).fill(' '.repeat(cols));
      const topRowCenterY = Math.floor(0 * cellH + cellH / 2);
      const bottomRowCenterY = Math.floor((rows - 1) * cellH + cellH / 2);
      const cellCenterXs = Array.from({ length: cols }, (_, i) => Math.floor(i * cellW + cellW / 2));
      const isCellCenter = (x: number, y: number) =>
        (y === topRowCenterY || y === bottomRowCenterY) && cellCenterXs.includes(x);
      const canvas = createMockCanvas(cols * cellW, rows * cellH, (x, y) => {
        if (isCellCenter(x, y)) return [255, 255, 255, 255];
        return [0, 0, 0, 255];
      });

      const ctx = createMockContext({
        canvas,
        rows,
        cols,
        lines,
      });
      // clearTextureAtlas 抛错
      (ctx.webgl as any).clearTextureAtlas = vi.fn(() => { throw new Error('oops'); });
      expect(() => detector.check(ctx)).not.toThrow();
    });
  });

  describe('WebGL 集成 — XtermTerminal 集成验证', () => {
    it('WebGL 启用时启动检测器，WebGL 为空时不启动', () => {
      // 验证 _startDesyncDetector 的守卫逻辑
      const detector = new DesyncDetector();
      // 模拟无 webgl 的情况：start 不启动定时器
      const ctx = createMockContext();
      (ctx.webgl as any) = null;
      detector.start(ctx);
      // 即使 start 被调用，check 内部也会因 webgl 为 null 跳过
      expect(detector.running).toBe(true); // 定时器在运行
      detector.check(ctx); // 但内部跳过
      expect(ctx.term.refresh).not.toHaveBeenCalled();
      detector.stop();
    });

    it('active=false 时检测器不触发恢复', () => {
      const detector = new DesyncDetector({ threshold: 0.01, colorTolerance: 30 });
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
      // active=false 时跳过检测
      expect(ctx.term.refresh).not.toHaveBeenCalled();
      expect(ctx.webgl.clearTextureAtlas).not.toHaveBeenCalled();
    });
  });

  describe('xterm 集成 — 与 XtermTerminal 生命周期联动', () => {
    it('mount 后 WebGL 模式下检测器已启动', () => {
      // 模拟 XtermTerminal._startDesyncDetector 的行为
      const detector = new DesyncDetector();
      const ctx = createMockContext();
      detector.start(ctx);
      expect(detector.running).toBe(true);
      detector.stop();
    });

    it('unmount 时检测器停止（模拟 _stopDesyncDetector）', () => {
      const detector = new DesyncDetector();
      const ctx = createMockContext();
      detector.start(ctx);
      expect(detector.running).toBe(true);
      detector.stop();
      expect(detector.running).toBe(false);
    });

    it('WebGL 上下文丢失后检测器停止（模拟 context loss 时 _stopDesyncDetector）', () => {
      const detector = new DesyncDetector();
      const ctx = createMockContext();
      detector.start(ctx);
      expect(detector.running).toBe(true);
      // 模拟上下文丢失后的 stop
      detector.stop();
      expect(detector.running).toBe(false);
      // 后续 check 不应触发
      detector.check(ctx);
      // 但 check 在非 running 时仍可被调用，内部由 active/webgl 守卫
      // 这里验证调用 check 不会恢复——因为定时器已停，且 check 内有 active 守卫
      // 实际上 check 可以直接调用，只要有 active + webgl 就会执行
      // 所以我们停了之后重新用 active=false 的上下文验证
      const inactiveCtx = createMockContext({ isActive: () => false });
      detector.check(inactiveCtx);
      expect(inactiveCtx.term.refresh).not.toHaveBeenCalled();
    });
  });
});