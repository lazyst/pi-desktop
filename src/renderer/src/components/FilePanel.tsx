// File + Git panel. Lives in the app shell between the Sidebar and the main
// terminal area. Two tabs share a single root directory: 📁 文件 (FileTree)
// and 🌿 Git (GitView).
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { FileTree } from './FileTree';
import { GitView } from './GitView';
import { clampFilePanelWidth } from './sidebarGeometry';

type Tab = 'files' | 'git';

// 下拉框中“自动（跟随会话）”选项的特殊 value，不与任何真实目录冲突。
const AUTO_ROOT = '__auto__';

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
  // Root directory: default to the active session's cwd; otherwise empty
  // (file tree shows “未选择工作目录”). User can still pick an added dir via
  // the dropdown.
  const candidates = useMemo(() => {
    const set = new Set<string>(addedDirs);
    if (activeCwd) set.add(activeCwd);
    return Array.from(set);
  }, [addedDirs, activeCwd]);

  const [root, setRoot] = useState<string>(activeCwd ?? '');

  // 根目录是否处于“自动跟随活动会话”模式。用户手动从下拉框选了一个具体目录后
  // 切为 false（手动优先，不被 activeCwd 抢回）；选“自动（跟随会话）”选项后切回 true。
  // 用 state 而非 ref，使下拉框能正确高亮当前所处的模式。
  const [isAuto, setIsAuto] = useState(true);
  useEffect(() => {
    if (isAuto && activeCwd) {
      setRoot(activeCwd);
    }
  }, [activeCwd, isAuto]);

  // 自修复：addedDirs / activeCwd 是异步到达的（App 经 getConfig 填充）。
  // FilePanel 首次挂载时它们可能为空，root 初始为 ''，之后 activeCwd 异步到达后
  // 上方的 effect 会把它同步进 root。但当 root 已空或已不在 candidates 中、且
  // 用户未手动选择过具体目录（仍为自动模式）时，仅在「存在 activeCwd（已打开会话）」
  // 的前提下把 root 回落到该会话 cwd；若既无 activeCwd、也非手动模式，则保持空
  // （文件树显示“未选择工作目录”），不再默认回落到 addedDirs[0]（见产品逻辑调整：
  // 启动未打开会话时文件树应为空）。
  const effectiveRoot = isAuto
    ? (activeCwd ? candidates.find((c) => c === activeCwd) ?? activeCwd : '')
    : (root && candidates.includes(root) ? root : '');
  // 下拉框当前选中的值：自动模式用特殊标记 __auto__，手动模式用具体目录。
  const selectValue = isAuto ? AUTO_ROOT : effectiveRoot;
  const onPickRoot = (r: string) => {
    if (r === AUTO_ROOT) {
      // 恢复自动跟随活动会话
      setIsAuto(true);
      setRoot(activeCwd ?? '');
    } else {
      // 手动选定具体目录，之后不再被 activeCwd 抢回
      setIsAuto(false);
      setRoot(r);
    }
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
            value={selectValue}
            onChange={(e) => onPickRoot(e.target.value)}
            title="根目录"
          >
            <option value={AUTO_ROOT}>（自动 · 跟随会话）</option>
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
