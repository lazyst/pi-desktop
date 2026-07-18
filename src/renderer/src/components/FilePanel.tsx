// File + Git panel. Lives in the app shell between the Sidebar and the main
// terminal area. Two tabs share a single root directory: 📁 文件 (FileTree)
// and 🌿 Git (GitView).
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { FileTree } from './FileTree';
import { GitView } from './GitView';
import { clampFilePanelWidth } from './sidebarGeometry';

type Tab = 'files' | 'git';

interface Props {
  addedDirs: string[];
  activeCwd: string | null;
  onOpenFile: (relPath: string, fileName: string, root: string) => void;
  // 面板宽度（持久化于 config.filePanelWidth），可拖拽右缘调整。
  width: number;
  onResize: (w: number) => void;
}

export function FilePanel({ addedDirs, activeCwd, onOpenFile, width, onResize }: Props) {
  const [tab, setTab] = useState<Tab>('files');
  // Root directory: default to the active session's cwd, otherwise the first
  // added dir. User can override via the dropdown.
  const candidates = useMemo(() => {
    const set = new Set<string>(addedDirs);
    if (activeCwd) set.add(activeCwd);
    return Array.from(set);
  }, [addedDirs, activeCwd]);

  const [root, setRoot] = useState<string>(activeCwd ?? addedDirs[0] ?? '');

  // Follow the active session: when no explicit override has been made, keep
  // root in sync with the active session's cwd.
  const overrideRef = useRef(false);
  useEffect(() => {
    if (!overrideRef.current && activeCwd) {
      setRoot(activeCwd);
    }
  }, [activeCwd]);

  // 自修复：addedDirs / activeCwd 是异步到达的（App 经 getConfig 填充）。
  // FilePanel 首次挂载时它们可能为空，root 初始为 ''，之后 addedDirs 到了但
  // useState 初始值不会自动更新、activeCwd 又一直为 null → root 永久卡在 ''，
  // 导致文件树永远空、点击无反应。故当 root 为空或已不在 candidates 中时，
  // 自动回落到第一个候选目录（除非用户已手动选择过某个有效目录）。
  const effectiveRoot = candidates.length > 0 && (!root || !candidates.includes(root))
    ? candidates[0]
    : root;
  const onPickRoot = (r: string) => {
    overrideRef.current = true;
    setRoot(r);
  };

  const empty = candidates.length === 0;

  // 拖拽右缘改宽：实时跟手，松手经 onResize 回写 config。
  const resizeStart = useRef<{ startX: number; startWidth: number } | null>(null);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const onResizerMove = useCallback((e: globalThis.MouseEvent) => {
    const s = resizeStart.current;
    if (!s) return;
    const next = clampFilePanelWidth(s.startWidth + (e.clientX - s.startX), window.innerWidth);
    onResizeRef.current(next);
  }, []);
  const onResizerUp = useCallback(() => {
    resizeStart.current = null;
    document.removeEventListener('mousemove', onResizerMove);
    document.removeEventListener('mouseup', onResizerUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, [onResizerMove]);
  const onResizerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizeStart.current = { startX: e.clientX, startWidth: width };
    document.addEventListener('mousemove', onResizerMove);
    document.addEventListener('mouseup', onResizerUp);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }, [onResizerMove, onResizerUp, width]);

  return (
    <div className="file-panel" style={{ width }}>
      <div className="file-panel-header">
        <div className="file-panel-tabs">
          <button
            type="button"
            className={`fp-tab ${tab === 'files' ? 'active' : ''}`}
            onClick={() => setTab('files')}
          >
            📁 文件
          </button>
          <button
            type="button"
            className={`fp-tab ${tab === 'git' ? 'active' : ''}`}
            onClick={() => setTab('git')}
          >
            🌿 Git
          </button>
        </div>
        {!empty && (
          <select
            className="fp-root-select"
            value={effectiveRoot}
            onChange={(e) => onPickRoot(e.target.value)}
            title="根目录"
          >
            {candidates.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
      </div>

      <div className="file-panel-body">
        {empty ? (
          <div className="file-panel-empty">
            先用 <b>+目录</b> 添加工作目录，即可浏览文件与 Git 状态。
          </div>
        ) : tab === 'files' ? (
          <FileTree root={effectiveRoot} onOpenFile={onOpenFile} />
        ) : (
          <GitView cwd={effectiveRoot} />
        )}
      </div>

      {/* 右缘 4px 拖拽条：整高、ew-resize、hover 淡高亮，与窗口右缘缩放热区不冲突 */}
      <div
        className="file-panel-resizer"
        onMouseDown={onResizerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖拽调整文件面板宽度"
      />
    </div>
  );
}
