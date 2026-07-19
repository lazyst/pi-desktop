import { IconClose, IconNewSession } from './icons';

export interface TabItem {
  id: string;
  title: string;
}

interface Props {
  tabs: TabItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

// 集成终端 tab 条：列出所有终端实例，点击切 tab，每个 tab 右侧 × 关单个终端，
// 最右「+」新建终端。当前 active 的 tab 加 active class；关闭 × 默认隐藏，hover 才显示
// （CSS .tab-close 控制，T8 阶段补样式）。
export function TerminalTabBar({ tabs, activeId, onSelect, onClose, onNew }: Props) {
  return (
    <div className="terminal-tabbar" role="tablist">
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.id === activeId}
          className={t.id === activeId ? 'terminal-tab active' : 'terminal-tab'}
          onClick={() => onSelect(t.id)}
          title={t.title}
        >
          <span className="terminal-tab-title">{t.title}</span>
          <button
            type="button"
            className="tab-close"
            aria-label="关闭终端"
            title="关闭终端"
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.id);
            }}
          >
            <IconClose size={12} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="tab-new"
        aria-label="新建终端"
        title="新建终端"
        onClick={onNew}
      >
        <IconNewSession size={14} />
      </button>
    </div>
  );
}
