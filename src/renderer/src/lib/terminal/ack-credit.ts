/** ACK 信用追踪 —— 管理已提交给 xterm 但尚未解析的写 ACK。
 *
 * 当渲染端向 xterm 写入数据时，写入回调携带的 ACK 信用（`() => void`）被本模块持有，
 * 直到 xterm 确认已解析该写后才释放（调用 credit）。在 pane 销毁时，
 * `discardInFlightTerminalOutputAckCredits` 可以丢弃所有飞行中信用，避免
 * 因回调永不触发而泄漏 main 进程的背压窗口。
 */

/** ACK 信用目标（用于 WeakMap 键的 opaque 对象）。 */
type TerminalOutputAckTarget = object;

/** 飞行中 ACK 完成回调集。WeakMap 确保 terminal 无其他引用时自动 GC。 */
const inFlightAckCompletions = new WeakMap<TerminalOutputAckTarget, Set<() => void>>();

/**
 * 注册一组 ACK 信用。返回一个 `complete` 函数，调用时按序释放所有注册的 credit。
 * 若 `credits` 数组为空，返回 `undefined`。
 *
 * @param terminal - 信用关联的终端对象（用作 WeakMap 键）。
 * @param credits - 待注册的 credit 回调数组，按序执行。
 * @returns 用于一次释放所有 credit 的完成函数，或 `undefined`（当 credits 为空时）。
 */
export function registerTerminalOutputAckCredits(
  terminal: TerminalOutputAckTarget,
  credits: readonly (() => void)[],
): (() => void) | undefined {
  if (credits.length === 0) {
    return undefined;
  }

  let completions = inFlightAckCompletions.get(terminal);
  if (!completions) {
    completions = new Set();
    inFlightAckCompletions.set(terminal, completions);
  }

  let completed = false;
  const complete = (): void => {
    if (completed) {
      return;
    }
    completed = true;
    completions?.delete(complete);
    if (completions?.size === 0) {
      inFlightAckCompletions.delete(terminal);
    }
    for (const credit of credits) {
      credit();
    }
  };
  completions.add(complete);
  return complete;
}

/**
 * 丢弃指定终端的所有飞行中 ACK 信用。
 * 在 pane 销毁（unmount）时调用，确保不会因未解析的写 ACK 导致主进程背压泄漏。
 *
 * @param terminal - 需要丢弃信用的终端对象。
 */
export function discardInFlightTerminalOutputAckCredits(terminal: TerminalOutputAckTarget): void {
  const completions = inFlightAckCompletions.get(terminal);
  if (!completions) {
    return;
  }
  for (const complete of completions) {
    complete();
  }
}
