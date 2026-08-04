/**
 * mouse-hide-while-typing —— 打字时隐藏鼠标光标（对齐 Orca mouse-hide-while-typing.ts）
 *
 * 用户在终端中输入时，鼠标光标通常遮挡视线。本模块在用户开始输入时隐藏鼠标
 * 光标（CSS cursor: none），鼠标移动时重新显示。
 *
 * ## 设计思路
 *
 * - 通过 xterm 的 onData 事件监听用户输入：用户键盘输入时隐藏鼠标
 * - 通过宿主元素的 mousemove 事件监听鼠标移动：鼠标移动时恢复鼠标
 * - 返回 IDisposable，在 unmount 时清理监听器
 */

import type { IDisposable } from '@xterm/xterm'

/**
 * 在单个终端 pane 上安装打字隐藏鼠标行为。
 *
 * @param terminal 具有 onData 方法的 xterm Terminal 实例
 * @param container 终端宿主 DOM 元素
 * @returns IDisposable，用于清理监听器和恢复鼠标样式
 */
export function installMouseHideWhileTyping(
  terminal: { onData: (callback: () => void) => IDisposable },
  container: HTMLElement
): IDisposable {
  // 用户输入时隐藏鼠标光标
  const hideOnData = terminal.onData(() => {
    container.style.cursor = 'none'
  })

  // 鼠标移动时恢复光标
  const showOnMove = (): void => {
    container.style.cursor = ''
  }
  container.addEventListener('mousemove', showOnMove)

  return {
    dispose: () => {
      hideOnData.dispose()
      container.removeEventListener('mousemove', showOnMove)
      // 恢复鼠标样式
      container.style.cursor = ''
    }
  }
}