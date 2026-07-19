// 右栏容器（重构阶段 2D）：取代 FilePanel 作为新的右栏 Tab 容器。
// 内含两个固定 tab——「文件」（kind:'preview'）与「Git」（kind:'diff'），
// 用通用 TabBar 切换。props 与现有 FilePanel 保持一致，便于阶段 3 App 直接替换。
//
// 注意：FilePanel.tsx 仍保留（仅为过渡，阶段 3 会决定是否删除），本组件是新的右栏实现。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TabBar } from './TabBar';
import { FileTree } from './FileTree';
import { GitView } from './GitView';
import { clampRightPanelWidth } from './sidebarGeometry';

// 跨平台取目录名（最后一段路径），与 FilePanel.basename 一致：渲染进程 sandbox
// 不能 import node:path，故自行实现。
function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

// 下拉框中“自动（跟随会话）”选项的特殊 value，不与任何真实目录冲突。
const AUTO_ROOT = '__auto__';

type RightTab = 'files' | 'git';

interface Props {
  addedDirs: string[];
  activeCwd: string | null;
  // 点击文件 → 中间区新增预览 tab（由 App 处理）；此处仅透传回调。
  onOpenFile: (relPath: string, fileName: string, root: string) => void;
  // 点击 Git 工作区/提交 diff → 中间区新增 diff tab（由 App 处理）。
  onOpenWorkDiff: (cwd: string) => void;
  onOpenCommit: (cwd: string, hash: string) => void;
  width: number;
  onResize: (w: number) => void;
}

export function RightPanel({
  addedDirs,
  activeCwd,
  onOpenFile,
  onOpenWorkDiff,
  onOpenCommit,
  width,
  onResize,
}: Props) {
  // 右栏自身的 Tab 切换（文件树 / Git）。
  const [tab, setTab] = useState<RightTab>('files');

  // 候选根目录：addedDirs ∪ activeCwd（去重）。
  const candidates = useMemo(() => {
    const set = new Set<string>(addedDirs);
    if (activeCwd) set.add(activeCwd);
    return Array.from(set);
  }, [addedDirs, activeCwd]);

  // root：默认跟随 activeCwd；用户手动选了具体目录则切为手动（不被 activeCwd 抢回）。
  const [root, setRoot] = useState<string>(activeCwd ?? '');
  const [isAuto, setIsAuto] = useState(true);
  useEffect(() => {
    if (isAuto && activeCwd) {
      setRoot(activeCwd);
    }
  }, [activeCwd, isAuto]);

  // 自修复 + 有效根：自动模式下回落到 activeCwd（有会话时），否则空；
  // 手动模式下若 root 仍合法则用之，否则空。
  const effectiveRoot = isAuto
    ? activeCwd ?? ''
    : root && candidates.includes(root)
      ? root
      : '';
  const selectValue = isAuto ? AUTO_ROOT : effectiveRoot;
  const onPickRoot = (r: string) => {
    if (r === AUTO_ROOT) {
      setIsAuto(true);
      setRoot(activeCwd ?? '');
    } else {
      setIsAuto(false);
      setRoot(r);
    }
  };

  const empty = candidates.length === 0;

  // 拖拽右缘改宽：实时跟手，松手经 onResize 回写 config（用 clampRightPanelWidth 约束）。
  const resizeStart = useRef<{ startX: number; startWidth: number } | null>(null);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const onResizerMove = useCallback((e: globalThis.MouseEvent) => {
    const s = resizeStart.current;
    if (!s) return;
    const next = clampRightPanelWidth(s.startWidth + (e.clientX - s.startX), window.innerWidth);
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
    <div className="right-panel" style={{ width }}>
      <TabBar
        tabs={[
          { id: 'files', title: '文件', kind: 'preview' },
          { id: 'git', title: 'Git', kind: 'diff' },
        ]}
        activeId={tab}
        onSelect={(id) => setTab(id as RightTab)}
        onClose={() => {}}
        showNew={false}
      />

      {!empty && (
        <div className="right-panel-header">
          <select
            className="rp-root-select"
            value={selectValue}
            onChange={(e) => onPickRoot(e.target.value)}
            title="根目录"
          >
            <option value={AUTO_ROOT}>（自动 · 跟随会话）</option>
            {candidates.map((c) => (
              <option key={c} value={c}>{basename(c)}</option>
            ))}
          </select>
        </div>
      )}

      <div className="right-panel-body">
        {empty ? (
          <div className="file-panel-empty">
            先用 <b>+目录</b> 添加工作目录，即可浏览文件与 Git 状态。
          </div>
        ) : tab === 'files' ? (
          <FileTree root={effectiveRoot} onOpenFile={onOpenFile} />
        ) : (
          <GitView cwd={effectiveRoot} onOpenWorkDiff={onOpenWorkDiff} onOpenCommit={onOpenCommit} />
        )}
      </div>

      {/* 右缘 4px 拖拽条：整高、ew-resize、hover 淡高亮 */}
      <div
        className="right-panel-resizer"
        onMouseDown={onResizerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖拽调整右栏宽度"
      />
    </div>
  );
}
