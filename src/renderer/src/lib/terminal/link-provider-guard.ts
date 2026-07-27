import type { ILinkProvider, Terminal } from '@xterm/xterm'

/**
 * 包装 link provider，防止 `provideLinks` 中的同步 throw 逃逸到
 * `window.onerror` 导致渲染器崩溃。
 *
 * ## 为什么需要这个守卫
 *
 * xterm 的 web-links `LinkComputer._getWindowedLineStrings` 在处理病态回绕行时
 *（例如 agent CLI 输出中含有超宽/控制字符混乱的缓冲区）可能抛出
 * `RangeError: Invalid array length`。该 throw 从同步调用的 provider 中逃逸，
 * 会导致渲染器卡死，Chromium 随后将其杀死（`killed` exit 1）。
 * 降级为"本次悬停不返回链接"可以保持渲染器存活，用户只需移动鼠标即可重试。
 */
export function guardLinkProvider(provider: ILinkProvider, label: string): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      let callbackInvoked = false
      const trackedCallback: typeof callback = (links) => {
        callbackInvoked = true
        callback(links)
      }
      try {
        provider.provideLinks(bufferLineNumber, trackedCallback)
      } catch (error: unknown) {
        console.error(
          `[terminal] link provider "${label}" threw at bufferLineNumber ${bufferLineNumber}:`,
          error
        )
        // 仅当 provider 尚未通过回调返回链接时才调用 callback(undefined)，
        // 避免重复调用回调。
        if (!callbackInvoked) {
          callback(undefined)
        }
      }
    }
  }
}

/**
 * 修补 `terminal.registerLinkProvider`，使其自动使用 {@link guardLinkProvider}
 * 守卫所有后续注册的 provider —— 包括 xterm addons 通过 `loadAddon` 加载的内部 provider
 *（尤其是 web-links 的 `LinkComputer`）。
 *
 * 必须在任何 `loadAddon`/`registerLinkProvider` 调用之前执行。
 */
export function installGuardedLinkProviderRegistration(terminal: Terminal): void {
  // 避免在 Terminal 桩对象或未来 xterm 版本缺少 registerLinkProvider 时出错。
  if (typeof terminal.registerLinkProvider !== 'function') {
    return
  }
  const register = terminal.registerLinkProvider.bind(terminal)
  let providerCount = 0
  terminal.registerLinkProvider = (provider: ILinkProvider) => {
    providerCount += 1
    return register(guardLinkProvider(provider, `provider-${providerCount}`))
  }
}