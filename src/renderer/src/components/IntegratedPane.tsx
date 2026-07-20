import { useEffect, useRef, useState, useCallback, type MouseEvent } from 'react';
import { pi } from '../ipc';
import {
  acquirePane,
  mountPane,
  setPaneActive,
  schedulePaneResize,
  setPaneScrollHandler,
  scrollPaneToBottom,
  paneHandleContextMenu,
  releasePane,
} from './paneManager';

interface Props {
  // 终端实例 id，形如 'term-<uuid>'。同时作为 XtermTerminal 的 sessionKey（仅作标识），
  // 数据流的通道选择（IntegratedChannel）由 PaneManager 据本壳的 kind 决定。
  terminalId: string;
  // 是否当前可见（keep-alive 模式下非 active 不析构，仅隐藏 host + setActive(false)）。
  active: boolean;
}

// 集成终端壳（替代原 IntegratedTerminalPane）：仿 SessionPane，但驱动的是集成终端抽屉里的真实
// shell 实例。关键差异（已收编进 PaneManager.acquirePane 的 channel 选择）：
//  - 数据通道用 IntegratedChannel（terminal:* IPC），而非 SessionChannel。
//  - 卸载实例由 PaneManager.releasePane 完成；杀掉主进程侧 pty 的唯一入口是用户点 ×
//    （App.handleCloseTab → pi.destroyTerminal），本壳不负责。
// 其余（keep-alive、ResizeObserver、跳到底部浮钮）与 SessionPane 完全对齐，保证切 tab 不重建、
// 不闪首帧。对外 DOM 契约（.integrated-terminal-host / data-terminal / 隐藏 span）与原组件一致。
export function IntegratedPane({ terminalId, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // 视口是否贴底（驱动「跳到底部」浮钮显隐）。
  const [atBottom, setAtBottom] = useState(true);

  const handleContextMenu = useCallback((e: MouseEvent) => {
    paneHandleContextMenu(terminalId, e);
  }, [terminalId]);

  const handleJumpBottom = useCallback(() => {
    scrollPaneToBottom(terminalId);
  }, [terminalId]);

  // 创建终端实例一次（keep-alive）：经 PaneManager.acquirePane 取/建 IntegratedChannel 实例，
  // 跨 active 切换保留。非 active 时实例已建但等待 setActive(true) 时 open。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = acquirePane({ key: terminalId, kind: 'integrated', pi });
    // 视口贴底状态变化 → 驱动浮钮显隐。
    setPaneScrollHandler(terminalId, (bottom) => setAtBottom(bottom));
    if (active) mountPane(terminalId, host);
    return () => {
      // 清理时只卸载 xterm 渲染实例（经 PaneManager.releasePane 注销），
      // 不杀主进程侧 pty：销毁 pty 的唯一入口是用户点 ×（App.handleCloseTab → pi.destroyTerminal）；
      // 此处若也调 destroyTerminal，会在 React StrictMode 的 mount→unmount→mount 双调用（dev）
      // 或抽屉收起隐藏时误杀刚创建的 pty，导致“新建即消失 / 闪退”。
      // drawerOpen 收起只是 display:none 隐藏 Pane（不卸载），pty 自然保留（keep-alive）。
      releasePane(terminalId);
    };
  }, [terminalId]);

  // active 切换：通知 XtermTerminal 可见性（不销毁），首次 active 时 mount，切回时校准尺寸。
  useEffect(() => {
    if (active) {
      mountPane(terminalId, hostRef.current!); // 幂等：已挂载则直接 return
      setPaneActive(terminalId, true);         // 切回：flush + 强制 resize 校准尺寸
    } else {
      setPaneActive(terminalId, false);
    }
  }, [active, terminalId]);

  // 尺寸变化：交给 PaneManager → XtermTerminal 走防抖 refit。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => schedulePaneResize(terminalId));
    ro.observe(host);
    return () => ro.disconnect();
  }, [terminalId]);

  // 非 active 时整块隐藏（keep-alive），CSS display:none。
  const hidden = !active;

  return (
    <>
      <div
        ref={hostRef}
        data-terminal={terminalId}
        className={active ? 'integrated-terminal-host active' : 'integrated-terminal-host'}
        onContextMenu={handleContextMenu}
      />
      {/* 「跳到底部」浮钮：仅在视口上滚离底、且当前面板为 active 时显示。 */}
      {active && !atBottom && (
        <button
          type="button"
          className="jump-bottom visible"
          title="跳到底部"
          aria-label="跳到底部"
          onClick={handleJumpBottom}
        >
          ↓
        </button>
      )}
      {hidden && <span hidden data-testid="integrated-hidden" />}
    </>
  );
}
