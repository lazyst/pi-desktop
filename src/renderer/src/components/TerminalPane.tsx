import { useEffect, useRef, useState, useCallback, type MouseEvent } from 'react';
import { pi } from '../ipc';
import { XtermTerminal } from './XtermTerminal';
import { SessionChannel } from './terminalChannel';

interface Props {
  sessionKey: string;
  active: boolean;
}

// React 壳：仅负责生命周期（active 时挂载 XtermTerminal、非 active 时卸载）、
// 提供 host div、转发右键菜单与置底按钮。所有 xterm 渲染 / 缓冲 / 度量逻辑已收编进
// XtermTerminal（见 docs/adr/0002）。对外契约（props、IPC 信道、行为语义）与原 TerminalPane
// 完全一致，对 App.tsx / 主进程 / preload 完全透明。
export function TerminalPane({ sessionKey, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // keep-alive：实例只创建一次、跨 active 切换保留（对齐 VS Code setVisible 不析构语义）。
  // 非 active 时只隐藏 host（CSS display:none）+ 通知 XtermTerminal.setActive(false)，
  // 实例本身不销毁，避免「销毁→重建→WebGL 重探测」带来的切 tab 首帧闪。
  const termRef = useRef<XtermTerminal | null>(null);
  // 视口是否贴底（驱动「跳到底部」浮钮显隐）。
  const [atBottom, setAtBottom] = useState(true);

  const handleContextMenu = useCallback((e: MouseEvent) => {
    termRef.current?.handleContextMenu(e);
  }, []);

  const handleJumpBottom = useCallback(() => {
    termRef.current?.scrollToBottom();
  }, []);

  // 创建终端实例一次（keep-alive）：不随 active 频繁重建，避免切 tab 首帧闪。
  // 实例在组件挂载且 host 就绪时创建，组件卸载时销毁；可见性切换走 setActive。
  useEffect(() => {
    const host = hostRef.current;
    if (!host || termRef.current) return;
    const term = new XtermTerminal({ sessionKey, channel: new SessionChannel(pi, sessionKey), pi });
    // 视口贴底状态变化 → 驱动浮钮显隐（仅在状态翻转时回调，见 XtermTerminal.notifyScrollState）。
    term.onScrollState = (bottom) => setAtBottom(bottom);
    termRef.current = term;
    // 仅当当前就是 active 才立即 open；非 active 时实例已建但等待 setActive(true) 时 open。
    if (active) term.mount(host);
    return () => {
      term.unmount();
      termRef.current = null;
    };
  }, [sessionKey]);

  // active 切换：通知 XtermTerminal 可见性（不销毁），首次 active 时 mount，切回时校准尺寸。
  // 关键：切回可见时显式调 setActive(true) 而非仅 mount——mount 对“已挂载实例”是 no-op
  // （if mounted return），不会触发 resize；但 display:none 隐藏期间 xterm 尺寸为 0，
  // 切回后必须 flush + doResize 用真实容器尺寸重测，否则沿用隐藏期的 0 尺寸渲染，
  // 表现为“切回的终端变空白新终端、历史输出丢失 / 不能滚动”。切走时 active 已是 false，故
  // 此处 setActive(true) 能真正进入 doResize 分支（对齐 IntegratedTerminalPane）。
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (active) {
      term.mount(hostRef.current!); // 幂等：已 mount 则直接 return
      term.setActive(true);         // 切回：flush + 强制 resize 校准尺寸
    } else {
      term.setActive(false);
    }
  }, [active]);

  // 尺寸变化：交给 XtermTerminal 走防抖 refit（流式窗口内冻结，见 docs/adr/0002 T1）。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => termRef.current?.scheduleResize());
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
