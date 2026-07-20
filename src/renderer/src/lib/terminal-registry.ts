// 存活终端实例注册表（对齐 orca 的「单点订阅、批量刷新」思路）。
//
// 解耦目标（见 issue 05）：把「主题切换 / 全局字号变化 → 刷新所有存活 xterm 实例」的逻辑从
// 每个 XtermTerminal 实例内部上提为单点订阅——避免 N 个实例各自订阅 onThemeChange /
// onFontSizeChange（既重复、又与 XtermTerminal 关注点混杂）。
//
// 机制：XtermTerminal 在 mount 时 register、unmount 时 unregister；本模块在模块加载时一次性
// 订阅 onThemeChange / onFontSizeChange，任一全局变更即通过实例的 applyTheme / applyFontSize
// 刷新所有存活实例，并在 WebGL 下 forceRedraw 清纹理图集，避免旧配色/旧字形残留闪留。
import { onThemeChange, type Theme } from '../theme';
import { onFontSizeChange } from '../fontSize';

/** 存活终端必须实现的刷新接口（由 XtermTerminal 实现，避免循环依赖本模块直接 import 具体类）。 */
export interface LiveTerminal {
  applyTheme(theme: Theme): void;
  applyFontSize(size: number): void;
}

const liveTerminals = new Set<LiveTerminal>();

/** 注册一个存活终端（mount 时调用）。 */
export function registerTerminal(t: LiveTerminal): void {
  liveTerminals.add(t);
}

/** 注销一个终端（unmount 销毁时调用）。 */
export function unregisterTerminal(t: LiveTerminal): void {
  liveTerminals.delete(t);
}

/** 取当前存活终端数量（测试 / 调试用）。 */
export function liveTerminalCount(): number {
  return liveTerminals.size;
}

// 单点订阅：主题切换 → 刷新所有存活实例（含 forceRedraw 清 WebGL 纹理残留）。
onThemeChange((theme: Theme) => {
  liveTerminals.forEach((t) => t.applyTheme(theme));
});

// 单点订阅：全局字号变化 → 同步所有存活实例的 fontSize + resize + forceRedraw。
onFontSizeChange((size: number) => {
  liveTerminals.forEach((t) => t.applyFontSize(size));
});
