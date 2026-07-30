/**
 * 引用计数 watcher：同一 key 可被多次订阅，最后一处取消时才真正关闭底层 watcher。
 *
 * 通用参数 TKey 默认为 string，也可使用复合 key（如 `${root} ${dir}`）。
 */
export class ReferenceCountedWatcher<TKey = string> {
  private entries = new Map<TKey, { stop: () => void; refs: number }>();

  /**
   * 订阅 key。
   * - 如果 key 已存在，refs +1，**不调用** start。
   * - 如果 key 不存在，调用 start(key) 获取 stop 函数，refs 设为 1。
   */
  watch(key: TKey, start: (key: TKey) => () => void): void {
    const existing = this.entries.get(key);
    if (existing) {
      existing.refs += 1;
      return;
    }
    const stop = start(key);
    this.entries.set(key, { stop, refs: 1 });
  }

  /**
   * 取消订阅 key。
   * - refs -1，如果 refs <= 0 则调用 stop() 并删除 key。
   * - 如果 key 不存在，静默忽略。
   */
  unwatch(key: TKey): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) {
      entry.stop();
      this.entries.delete(key);
    }
  }

  /**
   * 销毁所有 watcher：对所有 key 调用 stop() 并清空 Map。
   * 调用后不可再使用此实例。
   */
  dispose(): void {
    for (const { stop } of this.entries.values()) {
      stop();
    }
    this.entries.clear();
  }
}