/**
 * DesyncDetector —— WebGL 渲染去同步检测器（增强版）。
 *
 * 当 WebGL 渲染器出现 canvas 内容与 xterm buffer 不匹配的乱码时，自动检测并触发
 * clearTextureAtlas() + refresh() 恢复。
 *
 * ## 与 Orca terminal-render-desync-sentinel 对齐的设计要点：
 *
 * - **持续性验证**：连续 N 次检测到同一批 cell 缺失才判定为真去同步。
 *   避免光标闪烁 / IME 候选窗 / 动画等导致的单帧误报。
 * - **跳过光标行**：光标所在行的 cell 不参与检测，因为光标闪烁会产生
 *   频繁的像素变化，在非光标行已有足够采样点。
 * - **全屏行扫描**：采样所有行（跳过光标行），而不只是顶底行。
 * - **证据记录**：记录去同步次数和最近一次恢复时间，供诊断。
 * - **不做像素级证据持久化**（不写磁盘），保持轻量。
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
  /** 持续性验证所需连续采样次数（默认 2）。 */
  persistentSamples?: number;
  /** 最小有效文本 cell 数（低于此值不检测，默认 100）。 */
  minTextCells?: number;
}

const DEFAULT_INTERVAL = 5000;
const DEFAULT_THRESHOLD = 0.1;
const DEFAULT_COLOR_TOLERANCE = 30;
const DEFAULT_PERSISTENT_SAMPLES = 2;
const DEFAULT_MIN_TEXT_CELLS = 100;

/** 两个缺失 cell 集合被判定为「重叠」的最小交集比率。 */
const MISSING_SET_MIN_OVERLAP = 0.5;

export class DesyncDetector {
  private _timer: ReturnType<typeof setInterval> | null = null;
  private readonly _interval: number;
  private readonly _threshold: number;
  private readonly _colorTolerance: number;
  private readonly _persistentSamples: number;
  private readonly _minTextCells: number;

  /** 按 pane 分别存储最近 N 次检测的缺失 cell 索引集合。 */
  private readonly _missingHistory = new Map<string, Set<number>[]>();

  /** 统计信息：检测总次数。 */
  private _totalChecks = 0;
  /** 统计信息：触发恢复的次数。 */
  private _totalRecoveries = 0;
  /** 统计信息：最近一次恢复的时间戳。 */
  private _lastRecoveryTime = 0;
  /** 统计信息：因持续性验证被过滤的误报次数。 */
  private _filteredFalsePositives = 0;

  constructor(options?: DesyncDetectorOptions) {
    this._interval = options?.interval ?? DEFAULT_INTERVAL;
    this._threshold = options?.threshold ?? DEFAULT_THRESHOLD;
    this._colorTolerance = options?.colorTolerance ?? DEFAULT_COLOR_TOLERANCE;
    this._persistentSamples = options?.persistentSamples ?? DEFAULT_PERSISTENT_SAMPLES;
    this._minTextCells = options?.minTextCells ?? DEFAULT_MIN_TEXT_CELLS;
  }

  /** 启动检测器。每 interval 毫秒采样一次，仅在 WebGL 启用且终端可见时执行。 */
  start(context: DesyncDetectorContext): void {
    this.stop();
    const paneKey = context.host.id || context.host.className || 'unknown';
    this._timer = setInterval(() => this._check(context, paneKey), this._interval);
  }

  /** 停止检测器，清除定时器。 */
  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._missingHistory.clear();
  }

  /** 检测器是否正在运行。 */
  get running(): boolean {
    return this._timer !== null;
  }

  /** 重置统计信息。 */
  resetStats(): void {
    this._totalChecks = 0;
    this._totalRecoveries = 0;
    this._lastRecoveryTime = 0;
    this._filteredFalsePositives = 0;
  }

  /** 获取统计信息。 */
  getStats(): { totalChecks: number; totalRecoveries: number; lastRecoveryTime: number; filteredFalsePositives: number } {
    return {
      totalChecks: this._totalChecks,
      totalRecoveries: this._totalRecoveries,
      lastRecoveryTime: this._lastRecoveryTime,
      filteredFalsePositives: this._filteredFalsePositives,
    };
  }

  /**
   * 执行一次检测：采样所有行（跳过光标行），对比 canvas 像素与 buffer 文本。
   * 需要连续 N 次检测到同一批 cell 缺失才触发恢复。
   *
   * 公开以便测试直接调用检测逻辑（无需等待定时器）。
   */
  check(context: DesyncDetectorContext): void {
    const paneKey = context.host.id || context.host.className || 'unknown';
    this._check(context, paneKey);
  }

  // ── 私有实现 ──

  private _check(context: DesyncDetectorContext, paneKey: string): void {
    const { term, webgl, host, isActive } = context;
    if (!term || !webgl || !host || !isActive()) return;

    const canvas = host.querySelector('canvas');
    if (!canvas || !(canvas instanceof HTMLCanvasElement)) return;

    const buffer = term.buffer.active;
    const viewportY = buffer.viewportY;
    const cursorY = buffer.cursorY; // 0-based，相对视口
    const rows = term.rows;
    const cols = term.cols;
    if (rows <= 0 || cols <= 0) return;

    // 优先尝试直接获取 canvas 的 2D 上下文（DOM 渲染器 / 测试环境），
    // 失败时通过离屏 canvas 绘制来读取像素（兼容 WebGL canvas）。
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
    if (cellWidth < 1 || cellHeight < 1) return;

    // 采样背景色：取 canvas 左上角像素
    const bgPixel = pixelReader.getImageData(0, 0, 1, 1).data;

    this._totalChecks++;

    // 逐格采样：跳过光标行，避免光标闪烁导致误报
    const missingCells = new Set<number>();
    let textCells = 0;

    for (let row = 0; row < rows; row++) {
      // 跳过光标行（光标闪烁会产生频繁的像素变化，导致误报）
      if (row === cursorY) continue;

      const line = buffer.getLine(viewportY + row);
      if (!line) continue;

      for (let col = 0; col < cols; col++) {
        const cell = line.getCell(col);
        if (!cell) continue;

        const chars = cell.getChars();
        // 跳过空 cell 和空格
        if (chars === '' || chars === ' ' || cell.getWidth() === 0) continue;

        // 在 cell 中心区域采样 2x2 像素
        const x = Math.floor(col * cellWidth + cellWidth * 0.5);
        const y = Math.floor(row * cellHeight + cellHeight * 0.5);

        if (x >= canvas.width || y >= canvas.height) continue;

        const pixel = pixelReader.getImageData(x, y, 1, 1).data;
        const isContentPixel = this._isDifferentFromBg(pixel, bgPixel);

        // 如果 buffer 有内容但 canvas 像素接近背景色 → 渲染缺失
        if (!isContentPixel) {
          missingCells.add(row * cols + col);
        }
        textCells++;
      }
    }

    // 不足最小文本 cell 数则跳过（无足够数据判定）
    if (textCells < this._minTextCells) {
      this._missingHistory.delete(paneKey);
      return;
    }

    // 不匹配率低于阈值则跳过
    const missPct = (100 * missingCells.size) / textCells;
    if (missPct < this._threshold * 100) {
      // 子阈值帧：清除历史，避免单次 spike 累积成 false positive
      this._missingHistory.delete(paneKey);
      return;
    }

    // ── 持续性验证 ──
    // 记录本次缺失 cell 集合，检查是否连续 N 次都检测到同一批 cell 缺失
    const history = this._missingHistory.get(paneKey) ?? [];
    history.push(missingCells);

    // 只保留最近 N 次记录
    while (history.length > this._persistentSamples) {
      history.shift();
    }
    this._missingHistory.set(paneKey, history);

    // 历史不足 N 次，暂不判定
    if (history.length < this._persistentSamples) {
      return;
    }

    // 检查最近 N 次缺失集合是否相互重叠（持续性验证）
    for (let i = 1; i < history.length; i++) {
      if (!this._missingSetsOverlap(history[i - 1], history[i])) {
        // 不重叠 → 说明每次缺失的 cell 不同，是闪烁/动画等暂时现象，非真去同步
        this._filteredFalsePositives++;
        this._missingHistory.delete(paneKey);
        return;
      }
    }

    // 持续性验证通过 → 真去同步，触发恢复
    this._missingHistory.delete(paneKey);
    this._triggerRecovery(webgl, term, rows);
  }

  /** 触发恢复：清空纹理图集 + 刷新视口。 */
  private _triggerRecovery(webgl: WebglAddon, term: Terminal, rows: number): void {
    try {
      webgl.clearTextureAtlas();
      term.refresh(0, rows - 1);
      this._totalRecoveries++;
      this._lastRecoveryTime = Date.now();
    } catch {
      // 恢复失败静默忽略（如渲染器已失效）
    }
  }

  /** 判断两个缺失 cell 集合是否有足够重叠（交集占比 >= MISSING_SET_MIN_OVERLAP）。 */
  private _missingSetsOverlap(a: Set<number>, b: Set<number>): boolean {
    let intersection = 0;
    for (const cell of b) {
      if (a.has(cell)) {
        intersection++;
      }
    }
    const union = a.size + b.size - intersection;
    return union > 0 && intersection / union >= MISSING_SET_MIN_OVERLAP;
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