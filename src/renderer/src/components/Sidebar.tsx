import { useEffect, useState, useRef, useCallback, type MouseEvent } from 'react';
import type { SessionStatus } from '../types';
import { IconNewSession, IconPin, IconTrash } from './icons';
import { ContextMenu } from './ContextMenu';
import { clampSidebarWidth } from './sidebarGeometry';
import { defaultConfig } from '../../../main/config';

interface Session { key: string; cwd: string; name: string; time?: string; }
interface Props {
  sessions: Session[];
  statusMap: Record<string, SessionStatus>;
  activeKey?: string | null;
  pinned: string[];
  onOpen: (req: { key?: string; cwd?: string; name?: string }) => void;
  onTerminate: (key: string) => void;
  onPickDirectory: () => void;
  onTogglePin: (cwd: string) => void;
  onDeleteSession: (key: string, name: string) => void;
  // 多选模式：整条侧边栏进入选择态，每条会话显示 checkbox，点击切换勾选。
  selectionMode?: boolean;
  selectedKeys?: Set<string>;
  onToggleSelect?: (key: string) => void;
  onClearDirectory?: (cwd: string) => void;
  onEnterSelect?: () => void;
  onExitSelect?: (clear?: boolean) => void;
  onBatchDelete?: () => void;
  // live `live-<uuid>` key → on-disk `.jsonl` path, so a promoted session can be
  // highlighted as active using its on-disk key.
  relink?: Record<string, string>;
  // 侧边栏宽度（持久化于 config.sidebarWidth）与拖拽松手后的回写回调
  // （见 docs/adr/0001 决策④）。
  sidebarWidth?: number;
  onSidebarResize?: (w: number) => void;
}

export function Sidebar({ sessions, statusMap, activeKey, pinned, onOpen, onTerminate, onPickDirectory, onTogglePin, onDeleteSession, relink,
  selectionMode, selectedKeys, onToggleSelect, onClearDirectory, onEnterSelect, onExitSelect, onBatchDelete,
  sidebarWidth, onSidebarResize }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ key: string; name: string; x: number; y: number } | null>(null);

  // 侧边栏宽度由 state 控制（初始取 config.sidebarWidth，默认 280）；拖拽实时改、松手经
  // onSidebarResize 回写 config（见 docs/adr/0001 决策④）。
  const sidebarRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number>(sidebarWidth ?? defaultConfig().sidebarWidth);
  const widthRef = useRef<number>(width);
  // 异步加载的 config.sidebarWidth 经 prop 流入时，同步到本地宽度 state；
  // 拖拽过程中只走本地 setWidth（prop 不变，故本 effect 不触发），因此不冲突。
  useEffect(() => {
    if (sidebarWidth != null) setWidth(sidebarWidth);
  }, [sidebarWidth]);
  const resizeStart = useRef<{ startX: number; startWidth: number } | null>(null);
  // 把最新的 onSidebarResize 存进 ref，使拖拽监听回调保持稳定、不依赖 prop 身份。
  const onResizeRef = useRef(onSidebarResize);
  onResizeRef.current = onSidebarResize;

  const onResizerMove = useCallback((e: globalThis.MouseEvent) => {
    const s = resizeStart.current;
    if (!s) return;
    const next = clampSidebarWidth(s.startWidth + (e.clientX - s.startX), window.innerWidth);
    widthRef.current = next;
    setWidth(next); // 实时跟手；终端区靠既有 ResizeObserver 自动重排
  }, []);

  const onResizerUp = useCallback(() => {
    resizeStart.current = null;
    document.removeEventListener('mousemove', onResizerMove);
    document.removeEventListener('mouseup', onResizerUp);
    if (onResizeRef.current) onResizeRef.current(widthRef.current);
  }, [onResizerMove]);

  const onResizerDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    // jsdom / 隐藏态下 offsetWidth 为 0，退回当前跟踪宽度（真实浏览器走 offsetWidth）。
    const startWidth = sidebarRef.current?.offsetWidth || widthRef.current;
    resizeStart.current = { startX: e.clientX, startWidth };
    document.addEventListener('mousemove', onResizerMove);
    document.addEventListener('mouseup', onResizerUp);
  }, [onResizerMove, onResizerUp]);

  // A new session is keyed `live-<uuid>` in the terminal area but appears in the
  // sidebar under its on-disk `.jsonl` path once promoted. Map the active key to
  // its disk path so the promoted entry is highlighted as active.
  const effectiveActive = activeKey ? (relink?.[activeKey] ?? activeKey) : null;

  // 分组按 cwd；置顶分组排到最前（保持置顶先后顺序），其余维持原序。
  const pinnedSet = new Set(pinned);
  const rawGroups: Array<{ cwd: string; items: Session[] }> = [];
  const cwdIndex = new Map<string, number>();
  for (const s of sessions) {
    let i = cwdIndex.get(s.cwd);
    if (i === undefined) { i = rawGroups.length; cwdIndex.set(s.cwd, i); rawGroups.push({ cwd: s.cwd, items: [] }); }
    rawGroups[i].items.push(s);
  }
  const groups = [...rawGroups].sort((a, b) => {
    const pa = pinnedSet.has(a.cwd) ? pinned.indexOf(a.cwd) : Number.MAX_SAFE_INTEGER;
    const pb = pinnedSet.has(b.cwd) ? pinned.indexOf(b.cwd) : Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });

  return (
    <>
      <aside className="sidebar" ref={sidebarRef} style={{ width }}>
      <div className="sidebar-header">
        <span className="sidebar-title">会话</span>
        <div className="sidebar-actions">
          {selectionMode ? (
            <>
              <span className="select-count">已选 {selectedKeys?.size ?? 0} 项</span>
              <button className="btn btn-danger" data-action="batch-delete" onClick={onBatchDelete}>删除</button>
              <button className="btn" data-action="exit-select" onClick={() => onExitSelect?.(true)}>取消</button>
            </>
          ) : (
            <>
              <button className="btn" onClick={onPickDirectory}>+ 目录</button>
              <button className="btn" data-action="enter-select" title="选择会话进行批量删除" onClick={onEnterSelect}>管理</button>
            </>
          )}
        </div>
      </div>
      <div className="session-list">
        {groups.map((g) => {
          const isPinned = pinnedSet.has(g.cwd);
          const isOpen = !!expanded[g.cwd];
          const visible = isOpen ? g.items : g.items.slice(0, 5);
          const hidden = g.items.length - visible.length;
          return (
            <div key={g.cwd} className={`group${isPinned ? ' pinned' : ''}`}>
              <div className="group-title">
                <span className="group-name">📁 {g.cwd}</span>
                <span className="group-actions">
                  <button
                    className="icon-btn"
                    title={`置顶 ${g.cwd}`}
                    aria-label={`置顶 ${g.cwd}`}
                    data-action="pin"
                    onClick={() => onTogglePin(g.cwd)}
                  >
                    <IconPin />
                  </button>
                  <button
                    className="icon-btn"
                    title={`在 ${g.cwd} 新建会话`}
                    aria-label={`在 ${g.cwd} 新建会话`}
                    data-action="new-session"
                    onClick={() => onOpen({ cwd: g.cwd })}
                  >
                    <IconNewSession />
                  </button>
                  <button
                    className="icon-btn"
                    title={`清空 ${g.cwd} 下的所有会话`}
                    aria-label={`清空 ${g.cwd}`}
                    data-action="clear-directory"
                    onClick={() => onClearDirectory?.(g.cwd)}
                  >
                    <IconTrash />
                  </button>
                </span>
              </div>
              {visible.map((s) => {
                const running = statusMap[s.key] === 'running';
                // UX 兜底：状态未知（undefined，多半是状态推送尚未到达/竞态）时
                // 也允许显示「终止进程」——侧边栏里的会话基本都是运行中的 pi 进程，
                // 隐藏按钮反而让用户“连终止的机会都没有”（尤其 terminate 修复前那种
                // 点了没反应的体感）。仅当状态明确为 'dead' 时才隐藏（进程已退出）。
                const canTerminate = running || statusMap[s.key] === undefined;
                const isActive = s.key === effectiveActive;
                const selected = !!selectedKeys?.has(s.key);
                // 多选模式下：整条变为可勾选行，点击切换选中，不再打开终端面板。
                if (selectionMode) {
                  return (
                    <div
                      key={s.key}
                      data-key={s.key}
                      className={`session-item selectable${selected ? ' selected' : ''}`}
                      tabIndex={0}
                      aria-label={`选择会话 ${s.name}`}
                      aria-pressed={selected}
                      onClick={() => onToggleSelect?.(s.key)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onToggleSelect?.(s.key);
                        }
                      }}
                    >
                      <input
                        type="checkbox"
                        className="select-box"
                        checked={selected}
                        tabIndex={-1}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => onToggleSelect?.(s.key)}
                      />
                      <span className="session-name">
                        <div className="name">{s.name}</div>
                        {s.time && <div className="time">{s.time}</div>}
                      </span>
                    </div>
                  );
                }
                return (
                  <div
                    key={s.key}
                    data-key={s.key}
                    className={`session-item${isActive ? ' active' : ''}`}
                    tabIndex={0}
                    aria-label={`打开会话 ${s.name}`}
                    onClick={() => onOpen({ key: s.key })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpen({ key: s.key });
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ key: s.key, name: s.name, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <span className={`dot ${running ? 'running' : ''}`} />
                    <span className="session-name">
                      <div className="name">{s.name}</div>
                      {s.time && <div className="time">{s.time}</div>}
                    </span>
                    {canTerminate && (
                      <button className="terminate" title="终止进程" onClick={(e) => { e.stopPropagation(); onTerminate(s.key); }}>终止进程</button>
                    )}
                  </div>
                );
              })}
              {g.items.length > 5 && (
                <div
                  className="group-expand"
                  onClick={() => setExpanded((m) => ({ ...m, [g.cwd]: !isOpen }))}
                >
                  {isOpen ? '收起' : `展开 ${hidden} 个更多`}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* 右侧 4px 拖拽条：整高、ew-resize、hover 淡高亮；与窗口右缘的 rz-right 缩放热区不冲突 */}
      <div
        className="sidebar-resizer"
        onMouseDown={onResizerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖拽调整侧边栏宽度"
      />
      </aside>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[{ label: '删除会话', danger: true, onClick: () => onDeleteSession(menu.key, menu.name) }]}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
