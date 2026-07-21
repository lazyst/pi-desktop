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
  sessionKey: string;
  active: boolean;
}

// 会话终端壳（替代原 TerminalPane）：仅负责生命周期宿主（active 时挂载 XtermTerminal、非 active
// 时隐藏）、提供 host div、转发右键菜单与置底按钮。所有 keep-alive / resize / 缓冲 / 度量逻辑收编
// 进 PaneManager + XtermTerminal（见 docs/adr/0002）。对外契约（props、DOM class / data-*、行为语义）
// 与原 TerminalPane 完全一致，对 App.tsx / 主进程 / preload 完全透明。
export function SessionPane({ sessionKey, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // 视口是否贴底（驱动「跳到底部」浮钮显隐）。
  const [atBottom, setAtBottom] = useState(true);

  const handleContextMenu = useCallback((e: MouseEvent) => {
    paneHandleContextMenu(sessionKey, e);
  }, [sessionKey]);

  const handleJumpBottom = useCallback(() => {
    scrollPaneToBottom(sessionKey);
  }, [sessionKey]);

  // 创建终端实例一次（keep-alive）：经 PaneManager.acquirePane 取/建实例，跨 active 切换保留
  // （对齐 VS Code setVisible 不析构语义）。非 active 时只隐藏 host，实例本身不销毁。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = acquirePane({ key: sessionKey, kind: 'session', pi });
    // 视口贴底状态变化 → 驱动浮钮显隐（仅在状态翻转时回调，见 XtermTerminal.notifyScrollState）。
    setPaneScrollHandler(sessionKey, (bottom) => setAtBottom(bottom));
    // 仅当当前就是 active 才立即 open；非 active 时实例已建但等待 setActive(true) 时 open。
    if (active) mountPane(sessionKey, host);
    return () => {
      // 统一经 PaneManager.releasePane 销毁并注销实例（会话 pty 由主进程会话生命周期管理，此处不杀）。
      releasePane(sessionKey);
    };
  }, [sessionKey]);

  // active 切换：通知 XtermTerminal 可见性（不销毁），首次 active 时 mount，切回时校准尺寸。
  // 关键：切回可见时显式调 setPaneActive(true) 而非仅 mount——mount 对"已挂载实例"是 no-op
  // （if mounted return），不会触发 resize；但 opacity:0 隐藏期间 xterm 尺寸为 0，
  // 切回后必须 flush + doResize 用真实容器尺寸重测，否则沿用隐藏期的 0 尺寸渲染，
  // 表现为"切回的终端变空白新终端、历史输出丢失 / 不能滚动"。
  // 滚动位置保存/恢复由 CenterPane 在 activeCwd 切换前完成（对齐 Orca captureScrollState）。
  useEffect(() => {
    if (active) {
      mountPane(sessionKey, hostRef.current!); // 幂等：已挂载则直接 return
      setPaneActive(sessionKey, true);         // 切回：flush + 强制 resize 校准尺寸
    } else {
      setPaneActive(sessionKey, false);
    }
  }, [active, sessionKey]);

  // 尺寸变化：交给 PaneManager → XtermTerminal 走防抖 refit（流式窗口内冻结，见 docs/adr/0002 T1）。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => schedulePaneResize(sessionKey));
    ro.observe(host);
    return () => ro.disconnect();
  }, [sessionKey]);

  return (
    <>
      <div
        ref={hostRef}
        data-session={sessionKey}
        className={active ? 'terminal-host active' : 'terminal-host'}
        onContextMenu={handleContextMenu}
      />
      {/* 「跳到底部」浮钮：仅在视口上滚离底、且当前面板为 active 时显示（见 XtermTerminal.onScrollState）。
          点击调用 term.scrollToBottom() 回到最新输出。不参与非 active 面板的滚动态。 */}
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
    </>
  );
}
