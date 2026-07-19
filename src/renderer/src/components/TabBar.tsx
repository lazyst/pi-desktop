import { IconClose, IconNewSession, IconFile, IconGitDiff, IconSession } from './icons';

export type TabKind = 'session' | 'preview' | 'diff';

export interface TabBarItem {
  id: string;
  title: string;
  kind: TabKind;
  closable?: boolean;   // 默认 true；某些特殊 tab 可设为不可关闭
}

interface Props {
  tabs: TabBarItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew?: () => void;     // 可选：提供则在最右显示「+」新建按钮
  showNew?: boolean;      // 是否显示新建按钮（默认 onNew 存在且为 true）
}

// 通用 Tab 条：支持三种 tab kind（session/preview/diff）显示不同前缀图标，
// 每个 tab 右侧 × 关单个 tab，最右可选「+」新建按钮。复用 TerminalTabBar 的
// 视觉类名体系（terminal-tabbar / terminal-tab / tab-close / tab-new），CSS 无需大改。
// 当前 active 的 tab 加 active class；关闭 × 默认隐藏，hover 才显示（CSS 控制）。
export function TabBar({ tabs, activeId, onSelect, onClose, onNew, showNew }: Props) {
  const renderKindIcon = (kind: TabKind) => {
    switch (kind) {
      case 'session':
        return <IconSession size={14} />;
      case 'preview':
        return <IconFile size={14} />;
      case 'diff':
        return <IconGitDiff size={14} />;
      default:
        return null;
    }
  };

  const newVisible = showNew ?? onNew !== undefined;

  return (
    <div className="terminal-tabbar" role="tablist">
      {tabs.map((t) => {
        const closable = t.closable ?? true;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === activeId}
            className={t.id === activeId ? 'terminal-tab active' : 'terminal-tab'}
            onClick={() => onSelect(t.id)}
            title={t.title}
          >
            <span className="terminal-tab-icon">{renderKindIcon(t.kind)}</span>
            <span className="terminal-tab-title">{t.title}</span>
            {closable && (
              <button
                type="button"
                className="tab-close"
                aria-label="关闭"
                title="关闭"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
              >
                <IconClose size={12} />
              </button>
            )}
          </div>
        );
      })}
      {newVisible && onNew && (
        <button
          type="button"
          className="tab-new terminal-new-btn"
          aria-label="新建"
          title="新建"
          onClick={onNew}
        >
          <IconNewSession size={14} />
        </button>
      )}
    </div>
  );
}
