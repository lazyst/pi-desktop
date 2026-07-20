// PaneManager —— 终端实例（session + integrated-terminal）生命周期统一收编（见 issue 06）。
//
// 退役 TerminalPane.tsx / IntegratedTerminalPane.tsx 各自 hold 一套 keep-alive 逻辑的写法：
// 原本两个薄 React 壳各持一个 termRef、各自重复 keep-alive / resize / 滚动态回调逻辑。
// 现在所有实例的注册表与「keep-alive（非 active 不析构、切回校准尺寸）/ resize 防抖 /
// 5ms 数据缓冲 / 主题字号跟随」的统一驱动入口集中到本模块，由 PaneManager 持有实例注册表，
// SessionPane / IntegratedPane 两个薄壳只负责 host div、右键菜单与置底浮钮的 DOM 转发。
//
// 关键语义（对齐 VS Code terminalInstance.setVisible 不析构）：
//  - 实例只创建一次（keep-alive），跨 active 切换保留；非 active 时仅 setActive(false)
//    （壳把 host 设为 display:none），实例本身不销毁，避免「销毁→重建→WebGL 重探测」的切 tab 首帧闪。
//  - 切回 active 时显式 setActive(true)：flush + 强制 resize 校准尺寸（display:none 隐藏期
//    xterm 尺寸为 0，切回必须用真实容器尺寸重测，否则表现为「切回的终端变空白新终端、历史丢失」）。
//  - 5ms 数据缓冲 / 分轴 resize 防抖 / 主题字号跟随 已在 XtermTerminal + terminal-registry +
//    terminalDataBufferer + terminalResizeDebouncer 内实现，本模块只做实例登记与驱动，不重复堆逻辑。
//
// 两种通道（SessionChannel / IntegratedChannel）经统一 acquire/release/setActive 入口驱动，
// 差异仅在「构造时选哪条 channel」与「集成终端卸载时是否通知主进程销毁 pty」。
import { SessionChannel, IntegratedChannel } from './terminalChannel';
import type { TerminalChannel } from './terminalChannel';
import { XtermTerminal } from './XtermTerminal';
import type { PiApi } from '../ipc';

/** 终端种类：会话终端走 SessionChannel，集成终端走 IntegratedChannel。 */
export type PaneKind = 'session' | 'integrated';

/** acquire 参数。 */
export interface AcquireOptions {
  // 实例 key：会话终端为 sessionKey（如 '/a'），集成终端为 terminalId（如 'term-<uuid>'）。
  // 同时作为注册表主键与 XtermTerminal 的 sessionKey（仅作标识）。
  key: string;
  kind: PaneKind;
  pi: PiApi;
}

/**
 * 终端实例注册表（PaneManager 持有，替代原先 TerminalPane / IntegratedTerminalPane 各自的 termRef）。
 * key → 存活的 XtermTerminal 实例。keep-alive：同一 key 的实例跨 active 切换保留，不重建。
 */
const panes = new Map<string, XtermTerminal>();

/** 取当前存活实例数（测试 / 调试用）。 */
export function paneCount(): number {
  return panes.size;
}

/** 某 key 是否已有存活实例（keep-alive 判定）。 */
export function hasPane(key: string): boolean {
  return panes.has(key);
}

/**
 * 取某 key 的存活实例（无则构造）。统一入口：session / integrated 两种通道差异仅在 channel 构造，
 * 其余 keep-alive / resize / 缓冲逻辑全部复用同一个 XtermTerminal。
 * 构造时即绑定正确的 channel，对 XtermTerminal 本身完全透明（它只认 TerminalChannel 抽象）。
 */
export function acquirePane({ key, kind, pi }: AcquireOptions): XtermTerminal {
  const existing = panes.get(key);
  if (existing) return existing; // keep-alive：已存在则直接复用，不重建（避免 WebGL 重探测首帧闪）。

  const channel: TerminalChannel =
    kind === 'integrated'
      ? new IntegratedChannel(pi, key)
      : new SessionChannel(pi, key);

  const term = new XtermTerminal({ sessionKey: key, channel, pi });
  panes.set(key, term);
  return term;
}

/**
 * keep-alive：active 切换时调用，不销毁实例（对齐 VS Code setVisible）。
 * active=true 时 XtermTerminal.setActive(true) 会 flush + 强制 resize 校准尺寸；
 * active=false 时仅标记不可见（壳把 host 设为 display:none）。
 */
export function setPaneActive(key: string, active: boolean): void {
  panes.get(key)?.setActive(active);
}

/** 尺寸变化：交给 XtermTerminal 走分轴防抖 refit。 */
export function schedulePaneResize(key: string): void {
  panes.get(key)?.scheduleResize();
}

/** 设置视口贴底状态回调（驱动「跳到底部」浮钮显隐）。仅在状态翻转时由 XtermTerminal 回调。 */
export function setPaneScrollHandler(key: string, cb: ((atBottom: boolean) => void) | null): void {
  const term = panes.get(key);
  if (term) term.onScrollState = cb;
}

/** 跳到底部：把视口滚动到最新输出（由壳的浮钮点击调用）。 */
export function scrollPaneToBottom(key: string): void {
  panes.get(key)?.scrollToBottom();
}

/** 右键上下文菜单：转发到 XtermTerminal.handleContextMenu（有选区复制、否则粘贴）。 */
export function paneHandleContextMenu(key: string, e: { preventDefault: () => void }): void {
  panes.get(key)?.handleContextMenu(e);
}

/** 首次进入 active 且 host 就绪时挂载终端（幂等：已 mount 则 no-op）。 */
export function mountPane(key: string, host: HTMLElement): void {
  panes.get(key)?.mount(host);
}

/**
 * 真正销毁实例：从注册表移除并 unmount（释放所有监听与定时器、显式 loseContext 释放 WebGL）。
 * 会话终端：仅卸载渲染实例（会话 pty 由主进程会话生命周期管理，此处不杀）。
 * 集成终端：卸载实例后由调用方（用户点 × → App.handleCloseTab → pi.destroyTerminal）杀掉主进程 pty；
 * 抽屉收起（drawerOpen=false→display:none 隐藏）只是隐藏、不调 releasePane，pty 自然保留（keep-alive）。
 */
export function releasePane(key: string): void {
  const term = panes.get(key);
  if (!term) return;
  term.unmount();
  panes.delete(key);
}

/** 清空全部实例（测试 / 应用卸载时调用）。 */
export function resetPanes(): void {
  for (const term of panes.values()) term.unmount();
  panes.clear();
}
