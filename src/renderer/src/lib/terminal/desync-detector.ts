/**
 * DesyncDetector —— WebGL 渲染去同步检测器（可选）。
 *
 * 当 WebGL 渲染器出现 canvas 内容与 xterm buffer 不匹配的乱码时，自动检测并触发
 * clearTextureAtlas() + refresh() 恢复。
 *
 * 设计要点：
 *  - 不做全屏像素级扫描，仅采样顶行和底行对比
 *  - 不做像素级证据持久化（不写磁盘）
 *  - 发现不匹配 > 10% 直接恢复
 *  - 仅当 WebGL 启用且终端可见时执行检测
 */

import type { Terminal } from '@xterm/xterm';
import type { WebglAddon } from '@xterm/addon-webgl';

/** DesyncDetector 运行所需的终端上下文。 */
export interface DesyncDetectorContext {
  /** xterm Terminal 实例（用于 buffer 读取和 refresh）。 */
  readonly term: Terminal;
  /** WebGL addon 实例（用于 clearTextureAtlas）。 */
  readonly webgl: WebglAddon;
  /** 宿主 DOM 元素（用于查找 canvas）。 */
  readonly host: HTMLElement;
  /** 终端是否可见（仅在 active 时检测）。使用 getter 函数以确保每次检测时读取最新状态。 */
  readonly isActive: () => boolean;
}

export interface DesyncDetectorOptions {
  /** 检测间隔（毫秒，默认 5000）。 */
  interval?: number;
  /** 不匹配阈值（百分比，默认 0.1 = 10%）。 */
  threshold?: number;
  /** 像素颜色比较容差（0-255，默认 30）。 */
  colorTolerance?: number;
}

const DEFAULT_INTERVAL = 5000;
const DEFAULT_THRESHOLD = 0.1;
const DEFAULT_COLOR_TOLERANCE = 30;

export class DesyncDetector {
  private _timer: ReturnType<typeof setInterval> | null = null;
  private readonly _interval: number;
  private readonly _threshold: number;
  private readonly _colorTolerance: number;

  constructor(options?: DesyncDetectorOptions) {
    this._interval = options?.interval ?? DEFAULT_INTERVAL;
    this._threshold = options?.threshold ?? DEFAULT_THRESHOLD;
    this._colorTolerance = options?.colorTolerance ?? DEFAULT_COLOR_TOLERANCE;
  }

  /** 启动检测器。每 interval 毫秒采样一次，仅在 WebGL 启用且终端可见时执行。 */
  start(context: DesyncDetectorContext): void {
    this.stop();
    this._timer = setInterval(() => this._check(context), this._interval);
  }

  /** 停止检测器，清除定时器。 */
  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** 检测器是否正在运行。 */
  get running(): boolean {
    return this._timer !== null;
  }

  /**
   * 执行一次检测：采样顶行和底行，对比 canvas 像素与 buffer 文本。
   * 不匹配率超过阈值时触发恢复。
   *
   * 公开以便测试直接调用检测逻辑（无需等待定时器）。
   */
  check(context: DesyncDetectorContext): void {
    this._check(context);
  }

  // ── 私有实现 ──

  private _check(context: DesyncDetectorContext): void {
    const { term, webgl, host, isActive } = context;
    // 仅当 WebGL 启用且终端可见时检测
    if (!term || !webgl || !host || !isActive()) return;

    const canvas = host.querySelector('canvas');
    if (!canvas || !(canvas instanceof HTMLCanvasElement)) return;

    const buffer = term.buffer.active;
    const viewportY = buffer.viewportY;
    const rows = term.rows;
    const cols = term.cols;
    if (rows <= 0 || cols <= 0) return;

    // 优先尝试直接获取 canvas 的 2D 上下文（DOM 渲染器 / 测试环境），
    // 失败时通过离屏 canvas 绘制来读取像素（兼容 WebGL canvas，
    // 不能用 getContext('2d') 直接读）。
    let pixelReader: CanvasRenderingContext2D | null = canvas.getContext('2d');
    if (!pixelReader) {
      const offscreen = document.createElement('canvas');
      offscreen.width = canvas.width;
      offscreen.height = canvas.height;
      pixelReader = offscreen.getContext('2d');
      if (!pixelReader) return;
      pixelReader.drawImage(canvas, 0, 0);
    }

    const cellWidth = canvas.width / cols;
    const cellHeight = canvas.height / rows;
    // 守卫：cell 尺寸过小时跳过（布局未就绪）
    if (cellWidth < 1 || cellHeight < 1) return;

    // 采样背景色：取 canvas 左上角像素
    const bgPixel = pixelReader.getImageData(0, 0, 1, 1).data;

    let totalMismatches = 0;
    let totalCells = 0;

    // 仅采样顶行和底行
    const rowOffsets = [0, rows - 1];

    for (const rowOffset of rowOffsets) {
      const line = buffer.getLine(viewportY + rowOffset);
      if (!line) continue;

      const text = line.translateToString();
      const y = Math.floor(rowOffset * cellHeight + cellHeight / 2);

      for (let col = 0; col < cols; col++) {
        totalCells++;
        const x = Math.floor(col * cellWidth + cellWidth / 2);
        const pixel = pixelReader.getImageData(x, y, 1, 1).data;

        const isContentPixel = this._isDifferentFromBg(pixel, bgPixel);
        const isContentText = col < text.length && text[col] !== ' ';

        // 不匹配：canvas 渲染了内容但 buffer 是空格，或反之
        if (isContentPixel !== isContentText) {
          totalMismatches++;
        }
      }
    }

    // 达到阈值 → 触发恢复
    if (totalCells > 0 && totalMismatches / totalCells > this._threshold) {
      try {
        webgl.clearTextureAtlas();
        term.refresh(0, rows - 1);
      } catch {
        // 恢复失败静默忽略（如渲染器已失效）
      }
    }
  }

  /** 判断像素是否与背景色有明显差异（超出容差阈值）。 */
  private _isDifferentFromBg(pixel: Uint8ClampedArray, bg: Uint8ClampedArray): boolean {
    return (
      Math.abs(pixel[0] - bg[0]) > this._colorTolerance ||
      Math.abs(pixel[1] - bg[1]) > this._colorTolerance ||
      Math.abs(pixel[2] - bg[2]) > this._colorTolerance
    );
  }
}