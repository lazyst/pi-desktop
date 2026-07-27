/**
 * 检测 xterm 实例是否已销毁（disposed）的探针函数。
 *
 * 为什么使用私有字段探针：
 * xterm 没有公开的 disposed 标志位，write() 在已销毁的实例上会静默丢弃完成回调——
 * 既不抛异常也不触发事件（已在 vendored 的 6.1.0-beta.287 上验证）。
 * 这种静默丢弃是「僵尸 pane」的隐形生产者：写入已销毁实例的 restore 操作不留任何痕迹。
 * 本探针的作用就是给 breadcrumbs 命名这个时刻。
 * `_core._store._isDisposed` 是 vendored 构建中 dispose 时唯一翻转的字段；
 * 测试将它钉住，如果 vendored 升级后字段移动了，测试会大声失败，而不是静默让探针返回 false，
 * 从而让僵尸 pane 的埋点失明。
 */
export function isXtermInstanceDisposed(terminal: unknown): boolean {
  const core = (terminal as { _core?: { _store?: { _isDisposed?: unknown } } } | null)?._core
  return core?._store?._isDisposed === true
}