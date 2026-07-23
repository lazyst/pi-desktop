/**
 * MouseWheelClassifier —— 移植自 VS Code
 * src/vs/base/browser/ui/scrollbar/scrollableElement.ts 的 MouseWheelClassifier。
 *
 * 作用：通过分析最近 N 次滚轮事件的 delta 模式，判断滚动源是物理滚轮（鼠标）
 * 还是触控板/魔术鼠标。物理滚轮启用平滑滚动动画，触控板禁用平滑滚动以避免
 * 与系统触控板手势冲突。
 *
 * 与 VS Code 原版的差异：
 *   - 简化了 Chrome 特有的 pageZoomFactor 修正（本项目 Electron 环境中 zoomFactor
 *     已由 Chromium 统一处理，无需额外修正）。
 *   - 保留核心算法：最近 5 次事件的 delta 打分，物理滚轮 score ≤ 0.5。
 */
export class MouseWheelClassifier {
  public static readonly INSTANCE = new MouseWheelClassifier();

  private readonly _capacity = 5;
  private _memory: MouseWheelClassifierItem[];
  private _front: number;
  private _rear: number;

  constructor() {
    this._memory = [];
    this._front = -1;
    this._rear = -1;
  }

  /**
   * 判断当前滚动源是否为物理滚轮。
   * 当无历史数据时返回 false（默认安全值：不启用平滑滚动）。
   */
  isPhysicalMouseWheel(): boolean {
    if (this._front === -1 && this._rear === -1) {
      // no elements
      return false;
    }

    // 加权平均：最近一次 50%，前一次 25%，再前一次 12.5%，依此类推
    let remainingInfluence = 1;
    let score = 0;
    let iteration = 1;

    let index = this._rear;
    do {
      const influence = (index === this._front ? remainingInfluence : Math.pow(2, -iteration));
      remainingInfluence -= influence;
      score += this._memory[index].score * influence;

      if (index === this._front) {
        break;
      }

      index = (this._capacity + index - 1) % this._capacity;
      iteration++;
    } while (true);

    return score <= 0.5;
  }

  /**
   * 接受一次标准滚轮事件，更新分类器状态。
   * @param deltaX 水平滚动量
   * @param deltaY 垂直滚动量
   */
  accept(deltaX: number, deltaY: number): void {
    const timestamp = Date.now();
    const item = new MouseWheelClassifierItem(timestamp, deltaX, deltaY);

    let previousItem: MouseWheelClassifierItem | null = null;

    if (this._front === -1 && this._rear === -1) {
      this._memory[0] = item;
      this._front = 0;
      this._rear = 0;
    } else {
      previousItem = this._memory[this._rear];

      this._rear = (this._rear + 1) % this._capacity;
      if (this._rear === this._front) {
        // Drop oldest
        this._front = (this._front + 1) % this._capacity;
      }
      this._memory[this._rear] = item;
    }

    item.score = this._computeScore(item, previousItem);
  }

  /**
   * 计算单次事件的分数（0=物理滚轮，1=触控板）。
   *
   * 物理滚轮的特征：
   *   - 每次只在一个轴上有显著 delta（X 或 Y，不会同时都有大值）
   *   - 连续事件的 delta 值变化平滑（加速度曲线）
   *   - 每次滚动的 delta 值较大（典型值：100-500）
   *
   * 触控板的特征：
   *   - 每次事件两个轴通常都有 delta
   *   - 连续事件的 delta 变化更随机（手指停顿/抖动）
   *   - 每次滚动的 delta 值较小（典型值：1-50）
   */
  private _computeScore(
    item: MouseWheelClassifierItem,
    previousItem: MouseWheelClassifierItem | null,
  ): number {
    if (Math.abs(item.deltaX) > 0 && Math.abs(item.deltaY) > 0) {
      // 两个轴都有滚动 → 触控板特征
      return 1;
    }

    if (previousItem === null) {
      // 无历史数据：保守判断，但若 delta 绝对值很大则偏向物理滚轮
      return Math.abs(item.deltaX) + Math.abs(item.deltaY) < 100 ? 0.5 : 0.3;
    }

    // 检查 delta 是否稳定（连续事件的 delta 值相近 → 物理滚轮）
    const deltaX = Math.abs(item.deltaX) || Math.abs(previousItem.deltaX);
    const deltaY = Math.abs(item.deltaY) || Math.abs(previousItem.deltaY);
    const delta = Math.max(deltaX, deltaY);

    if (delta > 0 && previousItem.timestamp > 0) {
      const elapsed = item.timestamp - previousItem.timestamp;
      // 物理滚轮：连续事件间隔短（<50ms）、delta 大（>50）
      // 触控板：间隔随机、delta 小
      if (elapsed < 50 && delta > 50) {
        return 0.2; // 很可能是物理滚轮
      }
      if (elapsed < 100 && delta > 30) {
        return 0.4; // 可能是物理滚轮
      }
      if (delta < 20) {
        return 0.8; // 很可能触控板
      }
    }

    return 0.5; // 中性
  }
}

class MouseWheelClassifierItem {
  public timestamp: number;
  public deltaX: number;
  public deltaY: number;
  public score: number;

  constructor(timestamp: number, deltaX: number, deltaY: number) {
    this.timestamp = timestamp;
    this.deltaX = deltaX;
    this.deltaY = deltaY;
    this.score = 0;
  }
}