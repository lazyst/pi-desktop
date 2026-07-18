/**
 * MarkNavigationAddon —— 移植自 VS Code
 * src/vs/workbench/contrib/terminal/browser/xterm/markNavigationAddon.ts 的「mark 导航基座」。
 *
 * 作用：在终端 buffer 行上注册 marker，并提供以 marker 为锚点的滚动导航
 * （scrollToLine / scrollToClosestMarker），是命令装饰、错误跳转、mark 间跳转的技术基座。
 *
 * 与 VS Code 原版的差异（裁剪，不改导航语义）：
 *   - VS Code 深度耦合 capabilities / configurationService / themeService，并维护命令引导装饰
 *     （command guide decorations）；本项目是单进程 TUI 场景，移除这些依赖，只保留：
 *       * activate：绑定 xterm，监听 onData 时把当前导航 marker 重置到底部（对齐 VS Code）
 *       * scrollToLine：滚动到指定行（对齐 VS Code scrollToLine）
 *       * registerMarker：在指定行偏移注册 marker（对齐 VS Code _registerMarkerOrThrow）
 *       * scrollToClosestMarker：滚动到最近 marker（对齐 VS Code scrollToClosestMarker）
 *   - 不实现命令引导装饰、选区扩展、多 marker 循环导航的 IDE 交互——本项目无对应场景。
 */
import type { IMarker, ITerminalAddon, Terminal } from '@xterm/xterm';

export const enum ScrollPosition {
  Top = 'top',
  Middle = 'middle',
  Bottom = 'bottom',
}

const enum Boundary {
  Top,
  Bottom,
}

export class MarkNavigationAddon implements ITerminalAddon {
  private _terminal: Terminal | undefined;
  private _currentMarker: IMarker | Boundary = Boundary.Bottom;

  activate(terminal: Terminal): void {
    this._terminal = terminal;
    // 任意输入都把当前导航 marker 重置到底部（对齐 VS Code：输入即回到最新输出）。
    terminal.onData(() => {
      this._currentMarker = Boundary.Bottom;
    });
  }

  dispose(): void {
    this._terminal = undefined;
  }

  /** 滚动到指定行（对齐 VS Code scrollToLine）。 */
  scrollToLine(line: number, position: ScrollPosition = ScrollPosition.Top): void {
    if (!this._terminal) return;
    const target = this._getTargetScrollLine(line, position);
    this._terminal.scrollToLine(target);
  }

  private _getTargetScrollLine(line: number, position: ScrollPosition): number {
    if (!this._terminal) return line;
    const rows = this._terminal.rows;
    switch (position) {
      case ScrollPosition.Top:
        return line;
      case ScrollPosition.Middle:
        return Math.max(0, line - Math.floor(rows / 2));
      case ScrollPosition.Bottom:
        return Math.max(0, line - rows + 1);
      default:
        return line;
    }
  }

  /** 在相对当前光标Y的偏移处注册一个 marker（对齐 VS Code _registerMarkerOrThrow）。 */
  registerMarker(cursorYOffset: number): IMarker {
    if (!this._terminal) {
      throw new Error('terminal not attached');
    }
    const marker = this._terminal.registerMarker(cursorYOffset);
    if (!marker) {
      throw new Error('could not register marker');
    }
    return marker;
  }

  /**
   * 滚动到最近的 marker（对齐 VS Code scrollToClosestMarker 的语义）。
   * 本项目为最小实现：滚动到传入的 marker 行。
   * @param marker 目标 marker
   * @param highlight 是否高亮（本项目忽略，保留签名兼容）
   */
  scrollToClosestMarker(marker: IMarker, _highlight?: boolean): void {
    if (!this._terminal || marker.line < 0) return;
    this._currentMarker = marker;
    this.scrollToLine(marker.line, ScrollPosition.Top);
  }

  /** 当前导航 marker（供外部查询）。 */
  get currentMarker(): IMarker | Boundary {
    return this._currentMarker;
  }
}
