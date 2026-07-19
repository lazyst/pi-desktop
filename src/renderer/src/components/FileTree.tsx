import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as nodePath from 'node:path';
import { pi } from '../ipc';
import { clipboard, type ClipItem } from '../lib/clipboard';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { ConfirmDialog } from './ConfirmDialog';
import { FolderIcon, getFileIcon } from './FileIcons';

// 文件树 → 终端拖拽使用的自定义 MIME（区别于系统文件管理器的 'Files'）。
// XtermTerminal.bindDragAndDrop 同时识别该类型，实现「从内部文件树拖文件到终端即插入绝对路径」。
// 现承载 JSON 数组：被拖拽节点的相对路径列表（支持多选拖拽）。
export const PI_FILE_DRAG_MIME = 'application/x-pi-file';

/** 由 root + 相对路径算出绝对路径（跨平台分隔符 + . / .. 归一化）。 */
function toAbsolutePath(root: string, relPath: string): string {
  try {
    return nodePath.resolve(root, relPath);
  } catch {
    return relPath ? `${root}/${relPath}` : root;
  }
}

interface FileNode {
  name: string;
  fullPath: string; // path relative to the tree root
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

interface Props {
  root: string;
  onOpenFile: (relPath: string, fileName: string, root: string) => void;
  /** Bump to force a refresh of expanded directories. */
  refreshKey?: number;
}

async function fetchEntries(root: string, dirPath: string): Promise<FileNode[]> {
  const entries = await pi.fsListDir(root, dirPath);
  return entries.map((e) => ({
    name: e.name,
    fullPath: dirPath ? `${dirPath}/${e.name}` : e.name,
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
  }));
}

// 拖拽 / 菜单上下文：描述一次操作作用的「目标」。
interface TargetRef {
  relPath: string;
  isDir: boolean;
}

// inline 编辑态（新建伪节点或重命名既有节点）。
interface EditingState {
  relPath: string; // 对新建：父目录相对路径（'' 为根）；对重命名：节点自身相对路径
  isDir: boolean;
  isNew: boolean;
  // 新建伪节点在树里临时展示用的名字（编辑中），提交后落盘。
  draftName: string;
}

// 右键菜单状态。target=null 表示在空白区域（目录内底部）右键。
interface MenuState {
  x: number;
  y: number;
  target: TargetRef | null;
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

type TreeNodeProps = {
  node: FileNode;
  depth: number;
  root: string;
  onOpenFile: (relPath: string, fileName: string, root: string) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  dirRefresh: Record<string, number>;
  refreshKey: number;
  selection: Set<string>;
  onToggleSelect: (fullPath: string, e: React.MouseEvent) => void;
  onOpenContextMenu: (e: React.MouseEvent, target: TargetRef) => void;
  editing: EditingState | null;
  onCommitEdit: (value: string) => void;
  onCancelEdit: () => void;
  dropTarget: string | null;
  onDragOverDir: (fullPath: string | null) => void;
  onDropOnDir: (fullPath: string) => void;
  onDragStartNodes: (fullPaths: string[], e: React.DragEvent) => void;
  cutRelPaths: Set<string>;
};

function TreeNode({
  node,
  depth,
  root,
  onOpenFile,
  expandedPaths,
  onToggleExpanded,
  dirRefresh,
  refreshKey,
  selection,
  onToggleSelect,
  onOpenContextMenu,
  editing,
  onCommitEdit,
  onCancelEdit,
  dropTarget,
  onDragOverDir,
  onDropOnDir,
  onDragStartNodes,
  cutRelPaths,
}: TreeNodeProps) {
  const open = expandedPaths.has(node.fullPath);
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);

  // 本节点目录的刷新计数器（叠加全局 refreshKey），精确局部刷新。
  const dirToken = dirRefresh[node.fullPath] ?? 0;
  const refreshToken = `${refreshKey}:${dirToken}`;

  const loadChildren = useCallback(async (force = false) => {
    if (loaded && !force) return;
    setLoading(true);
    try {
      const entries = await fetchEntries(root, node.fullPath);
      setChildren(entries);
      setLoaded(true);
    } catch {
      // ignore — best-effort tree
    } finally {
      setLoading(false);
    }
  }, [loaded, node.fullPath, root]);

  useEffect(() => {
    if (open && loaded) {
      loadChildren(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      onToggleSelect(node.fullPath, e);
      return;
    }
    if (node.isDir) {
      const next = !open;
      onToggleExpanded(node.fullPath, next);
      if (next && !loaded) loadChildren();
    } else {
      onOpenFile(node.fullPath, node.name, root);
    }
  }, [node.isDir, node.fullPath, node.name, loaded, open, loadChildren, onOpenFile, onToggleExpanded, root, onToggleSelect]);

  // 正在编辑本节点（重命名或新建伪节点恰好落在此层级）？
  const isEditingHere = editing != null && (
    editing.isNew
      ? editing.relPath === node.fullPath // 新建伪节点挂在父目录下，父节点 fullPath === 新建.relPath
      : editing.relPath === node.fullPath
  );

  const className = [
    'file-row',
    selection.has(node.fullPath) ? 'selected' : '',
    cutRelPaths.has(node.fullPath) ? 'cut-pending' : '',
    dropTarget === node.fullPath ? 'drop-target' : '',
    isEditingHere ? 'editing' : '',
  ].filter(Boolean).join(' ');

  return (
    <div>
      <div
        className={className}
        draggable={!isEditingHere}
        onClick={handleClick}
        onContextMenu={(e) => onOpenContextMenu(e, { relPath: node.fullPath, isDir: node.isDir })}
        onDragStart={(e) => onDragStartNodes([node.fullPath], e)}
        onDragOver={(e) => {
          if (node.isDir) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            onDragOverDir(node.fullPath);
          }
        }}
        onDragLeave={() => { if (node.isDir && dropTarget === node.fullPath) onDragOverDir(null); }}
        onDrop={(e) => {
          if (node.isDir) {
            e.preventDefault();
            onDragOverDir(null);
            onDropOnDir(node.fullPath);
          }
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {node.isDir && (
          <svg
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ flexShrink: 0, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.1s' }}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
        )}
        {!node.isDir && <span style={{ width: 10, flexShrink: 0 }} />}
        <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
        </span>
        {isEditingHere ? (
          <input
            className="file-rename-input"
            autoFocus
            defaultValue={editing!.draftName}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onCommitEdit((e.target as HTMLInputElement).value);
              } else if (e.key === 'Escape') {
                onCancelEdit();
              }
            }}
            onBlur={(e) => onCommitEdit((e.target as HTMLInputElement).value)}
          />
        ) : (
          <span className="file-name" title={node.fullPath}>{node.name}</span>
        )}
        {loading && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
          </svg>
        )}
      </div>
      {node.isDir && open && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              root={root}
              onOpenFile={onOpenFile}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              dirRefresh={dirRefresh}
              refreshKey={refreshKey}
              selection={selection}
              onToggleSelect={onToggleSelect}
              onOpenContextMenu={onOpenContextMenu}
              editing={editing}
              onCommitEdit={onCommitEdit}
              onCancelEdit={onCancelEdit}
              dropTarget={dropTarget}
              onDragOverDir={onDragOverDir}
              onDropOnDir={onDropOnDir}
              onDragStartNodes={onDragStartNodes}
              cutRelPaths={cutRelPaths}
            />
          ))}
          {children.length === 0 && loaded && (
            <div className="file-empty" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>empty</div>
          )}
        </div>
      )}
    </div>
  );
}

export function FileTree({ root, onOpenFile, refreshKey }: Props) {
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [dirRefresh, setDirRefresh] = useState<Record<string, number>>({});
  const prevRootRef = useRef<string | null>(null);
  const refreshToken = `${refreshKey ?? 0}:${treeRefreshKey}`;

  // 文件管理交互状态
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [cutRelPaths, setCutRelPaths] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<ClipItem[] | null>(null);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  // 精确局部刷新某个目录层（含根 ''）。
  // 根目录的直接子项由本组件的 `roots` state 渲染（而非某个 TreeNode 的 children），
  // 故根刷新需重新拉取 roots；子目录刷新则只 bump dirRefresh（由其 TreeNode 自行重载）。
  const bumpDir = useCallback((relPath: string) => {
    if (relPath === '') {
      // 重新加载根层（更新 `roots` state），保留已展开状态。
      let cancelled = false;
      fetchEntries(root, '')
        .then((entries) => { if (!cancelled) setRoots(entries); })
        .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
      return () => { cancelled = true; };
    }
    setDirRefresh((prev) => ({ ...prev, [relPath]: (prev[relPath] ?? 0) + 1 }));
  }, [root]);

  useEffect(() => {
    const rootChanged = prevRootRef.current !== root;
    prevRootRef.current = root;

    if (rootChanged) {
      setExpandedPaths(new Set());
      setError(null);
      setRoots([]);
      setSelection(new Set());
      setEditing(null);
      setCutRelPaths(new Set());
      setDirRefresh({});
    }

    if (!root) {
      setLoading(false);
      return;
    }

    setLoading(rootChanged || roots.length === 0);
    setError(null);
    let cancelled = false;
    fetchEntries(root, '')
      .then((entries) => { if (!cancelled) setRoots(entries); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, refreshKey, treeRefreshKey]);

  // ── 选择 ──
  const onToggleSelect = useCallback((fullPath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(fullPath)) next.delete(fullPath); else next.add(fullPath);
      return next;
    });
  }, []);

  // ── 右键菜单 ──
  const onOpenContextMenu = useCallback((e: React.MouseEvent, target: TargetRef | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, target });
  }, []);

  // ── 新建（inline 伪节点，C2：输完名才落盘）──
  const startNew = useCallback((parentRel: string, isDir: boolean) => {
    setSelection(new Set());
    setEditing({ relPath: parentRel, isDir, isNew: true, draftName: isDir ? '新建文件夹' : '新建文件' });
    // 确保父目录展开可见
    if (parentRel && !expandedPaths.has(parentRel)) {
      setExpandedPaths((prev) => new Set(prev).add(parentRel));
    }
    setMenu(null);
  }, [expandedPaths]);

  const startRename = useCallback((relPath: string) => {
    setSelection(new Set([relPath]));
    setEditing({ relPath, isDir: false, isNew: false, draftName: basename(relPath) });
    setMenu(null);
  }, []);

  // 提交 inline 编辑
  const onCommitEdit = useCallback(async (value: string) => {
    if (!editing || !root) { setEditing(null); return; }
    const name = value.trim();
    setEditing(null);
    if (!name) return; // 空名 → 取消

    try {
      if (editing.isNew) {
        const parent = editing.relPath;
        const desired = parent ? `${parent}/${name}` : name;
        // 重名自动加 (1) 后缀
        const siblings = await pi.fsListNames(root, parent);
        const finalName = await pi.fsUniqueName(name, siblings);
        const finalRel = parent ? `${parent}/${finalName}` : finalName;
        if (editing.isDir) await pi.fsMkdir(root, finalRel);
        else await pi.fsCreateFile(root, finalRel, '');
        bumpDir(parent);
        // 新建后自动进入重命名态，让用户直接改默认名（符合「新建后让用户输入名字」）。
        // 根目录（parent===''）无对应 TreeNode 承载重命名 input，故仅结束编辑、依赖刷新显示新文件。
        if (parent !== '' && finalName === name) {
          setEditing({ relPath: finalRel, isDir: editing.isDir, isNew: false, draftName: name });
        } else {
          setEditing(null);
        }
      } else {
        const parent = editing.relPath.includes('/')
          ? editing.relPath.slice(0, editing.relPath.lastIndexOf('/'))
          : '';
        const desired = parent ? `${parent}/${name}` : name;
        if (desired === editing.relPath) return;
        const siblings = await pi.fsListNames(root, parent);
        const others = siblings.filter((n) => n !== basename(editing.relPath));
        const finalName = await pi.fsUniqueName(name, others);
        const finalRel = parent ? `${parent}/${finalName}` : finalName;
        await pi.fsRename(root, editing.relPath, finalRel);
        bumpDir(parent);
        if (editing.relPath.includes('/')) {
          bumpDir(editing.relPath.slice(0, editing.relPath.lastIndexOf('/')));
        }
      }
    } catch (e) {
      // 落盘失败：刷新以恢复真实状态
      bumpDir(editing.relPath.includes('/') ? editing.relPath.slice(0, editing.relPath.lastIndexOf('/')) : '');
      console.error('[file-tree] edit failed', e);
    }
  }, [editing, root, bumpDir]);

  const onCancelEdit = useCallback(() => setEditing(null), []);

  // ── 复制 / 剪切 / 粘贴 ──
  const doCut = useCallback((targets: ClipItem[]) => {
    clipboard.set({ mode: 'cut', items: targets });
    setCutRelPaths(new Set(targets.map((t) => t.relPath)));
    setMenu(null);
  }, []);

  const doCopy = useCallback((targets: ClipItem[]) => {
    clipboard.set({ mode: 'copy', items: targets });
    setCutRelPaths(new Set());
    setMenu(null);
  }, []);

  const doPaste = useCallback(async (destDir: string) => {
    const clip = clipboard.get();
    setMenu(null);
    if (!clip || !root) return;
    try {
      for (const item of clip.items) {
        const base = basename(item.relPath);
        const siblings = await pi.fsListNames(root, destDir);
        const finalName = await pi.fsUniqueName(base, siblings);
        const destRel = destDir ? `${destDir}/${finalName}` : finalName;
        if (clip.mode === 'copy') {
          await pi.fsCopy(root, item.relPath, destRel);
        } else {
          await pi.fsRename(root, item.relPath, destRel);
        }
      }
      if (clip.mode === 'cut') {
        clipboard.clear();
        setCutRelPaths(new Set());
      }
      bumpDir(destDir);
    } catch (e) {
      console.error('[file-tree] paste failed', e);
    }
  }, [root, bumpDir]);

  // ── 删除 ──
  const requestDelete = useCallback((targets: ClipItem[]) => {
    setMenu(null);
    // 单文件：直接删；目录 / 多选：确认
    const hasDirOrMulti = targets.length > 1 || targets.some((t) => t.isDir);
    if (!hasDirOrMulti) {
      void (async () => {
        try {
          await pi.fsRemove(root, targets[0].relPath);
          const p = targets[0].relPath.includes('/')
            ? targets[0].relPath.slice(0, targets[0].relPath.lastIndexOf('/'))
            : '';
          bumpDir(p);
        } catch (e) { console.error('[file-tree] delete failed', e); }
      })();
      return;
    }
    setConfirmDelete(targets);
  }, [root, bumpDir]);

  const confirmDeleteNow = useCallback(async () => {
    if (!confirmDelete || !root) { setConfirmDelete(null); return; }
    try {
      for (const item of confirmDelete) {
        await pi.fsRemove(root, item.relPath);
        const p = item.relPath.includes('/')
          ? item.relPath.slice(0, item.relPath.lastIndexOf('/'))
          : '';
        bumpDir(p);
      }
    } catch (e) { console.error('[file-tree] delete failed', e); }
    finally {
      setConfirmDelete(null);
      setSelection(new Set());
    }
  }, [confirmDelete, root, bumpDir]);

  // ── 拖拽（移动 / 复制到目录）──
  const onDragStartNodes = useCallback((fullPaths: string[], e: React.DragEvent) => {
    if (!e.dataTransfer) return;
    // 拖拽语义：拖的是已选中项之一 → 携带整个选中集；否则只携带被拖的这个
    const carrying = fullPaths.filter((p) => selection.has(p));
    const payload = carrying.length > 0 && carrying.some((p) => fullPaths.includes(p))
      ? [...selection]
      : fullPaths;
    const absList = payload.map((p) => toAbsolutePath(root, p));
    e.dataTransfer.setData(PI_FILE_DRAG_MIME, JSON.stringify(absList));
    e.dataTransfer.setData('text/plain', absList.join(' '));
    e.dataTransfer.effectAllowed = 'copyMove';
  }, [root, selection]);

  const onDropOnDir = useCallback(async (destDir: string) => {
    setDropTarget(null);
    if (!root) return;
    // 优先处理剪贴板粘贴（拖拽 + 有剪贴板内容时，这里只处理拖拽移动）
    const clip = clipboard.get();
    // 从拖拽 dataTransfer 取（在 XtermTerminal 之外，文件树内部拖放走 onDrop 直接拿 selection）
    const moving = selection.size > 0
      ? [...selection]
      : [];
    if (!moving.length) return;
    try {
      for (const rel of moving) {
        const base = basename(rel);
        const siblings = await pi.fsListNames(root, destDir);
        const finalName = await pi.fsUniqueName(base, siblings);
        const destRel = destDir ? `${destDir}/${finalName}` : finalName;
        if (destRel === rel) continue; // 落到自身
        await pi.fsRename(root, rel, destRel);
        const p = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        bumpDir(p);
      }
      bumpDir(destDir);
      if (clip?.mode === 'cut') { clipboard.clear(); setCutRelPaths(new Set()); }
    } catch (e) { console.error('[file-tree] move failed', e); }
    setSelection(new Set());
  }, [root, selection, bumpDir]);

  // 菜单项构造
  const menuItems: ContextMenuItem[] = useMemo(() => {
    if (!menu) return [];
    const clip = clipboard.get();
    const hasClip = !!clip && clip.items.length > 0;
    if (menu.target == null) {
      // 空白区域（目录内）
      const items: ContextMenuItem[] = [
        { label: '📄 新建文件', onClick: () => startNew(currentDirForMenu, false) },
        { label: '📁 新建目录', onClick: () => startNew(currentDirForMenu, true) },
      ];
      if (hasClip) items.push({ label: '📋 粘贴', onClick: () => void doPaste(currentDirForMenu) });
      return items;
    }
    const { relPath, isDir } = menu.target;
    // 选集：若右键目标在选集中 → 操作整个选集；否则只操作目标
    const targets: ClipItem[] = selection.has(relPath)
      ? [...selection].map((p) => ({ root, relPath: p, isDir: false }))
      : [{ root, relPath, isDir }];
    const items: ContextMenuItem[] = [];
    if (isDir) {
      items.push({ label: '📄 新建文件', onClick: () => startNew(relPath, false) });
      items.push({ label: '📁 新建目录', onClick: () => startNew(relPath, true) });
    }
    items.push({ label: '✂️ 剪切', onClick: () => doCut(targets) });
    items.push({ label: '📋 复制', onClick: () => doCopy(targets) });
    if (hasClip) items.push({ label: '📋 粘贴', onClick: () => void doPaste(relPath) });
    items.push({ label: '✏️ 重命名', onClick: () => startRename(relPath) });
    items.push({ label: '📂 在文件管理器打开', onClick: () => { void pi.fsShowInFolder(toAbsolutePath(root, relPath)); } });
    items.push({ label: '🗑️ 删除', danger: true, onClick: () => requestDelete(targets) });
    return items;
  }, [menu, selection, clipboard, root, startNew, startRename, doCut, doCopy, doPaste, requestDelete]);

  // 当前右键所在目录（用于空白区新建/粘贴）：若目标是目录则为其本身，否则取其父目录
  const currentDirForMenu = (() => {
    if (!menu) return '';
    if (menu.target == null) return '';
    const { relPath, isDir } = menu.target;
    return isDir ? relPath : (relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '');
  })();

  if (!root) {
    return <div className="file-empty">未选择工作目录</div>;
  }

  if (loading) {
    return <div className="file-empty">加载中…</div>;
  }
  if (error) {
    return <div className="file-error">{error}</div>;
  }
  if (roots.length === 0) {
    return (
      <div
        className="file-tree file-tree-empty"
        style={{ minHeight: '100%' }}
        onContextMenu={(e) => onOpenContextMenu(e, null)}
      >
        <div className="file-empty" style={{ paddingLeft: 8 }}>空目录</div>
      </div>
    );
  }

  return (
    <div
      className="file-tree"
      style={{ minHeight: '100%' }}
      onClick={() => { if (selection.size) setSelection(new Set()); }}
      onContextMenu={(e) => {
        // 点到文件行（或行内元素）视为节点右键；其余空白区域（含面板底部留白）视为空白右键。
        const onRow = (e.target as HTMLElement).closest('.file-row');
        if (!onRow) onOpenContextMenu(e, null);
      }}
    >
      {/* 根目录下的新建：根 TreeNode 不存在，故在列表顶部渲染独立 inline 输入行。 */}
      {editing && editing.isNew && editing.relPath === '' && (
        <div className="file-row editing" style={{ paddingLeft: 8 }}>
          <span style={{ width: 10, flexShrink: 0 }} />
          <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            {editing.isDir ? <FolderIcon size={14} open={false} /> : getFileIcon(editing.draftName, 14)}
          </span>
          <input
            className="file-rename-input"
            autoFocus
            defaultValue={editing.draftName}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCommitEdit((e.target as HTMLInputElement).value);
              else if (e.key === 'Escape') onCancelEdit();
            }}
            onBlur={(e) => onCommitEdit((e.target as HTMLInputElement).value)}
          />
        </div>
      )}
      {roots.map((node) => (
        <TreeNode
          key={node.fullPath}
          node={node}
          depth={0}
          root={root}
          onOpenFile={onOpenFile}
          expandedPaths={expandedPaths}
          onToggleExpanded={handleToggleExpanded}
          dirRefresh={dirRefresh}
          refreshKey={refreshKey ?? 0}
          selection={selection}
          onToggleSelect={onToggleSelect}
          onOpenContextMenu={onOpenContextMenu}
          editing={editing}
          onCommitEdit={onCommitEdit}
          onCancelEdit={onCancelEdit}
          dropTarget={dropTarget}
          onDragOverDir={setDropTarget}
          onDropOnDir={onDropOnDir}
          onDragStartNodes={onDragStartNodes}
          cutRelPaths={cutRelPaths}
        />
      ))}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="删除确认"
          message={`将删除 ${confirmDelete.length} 个项目${confirmDelete.some((t) => t.isDir) ? '（含目录及其全部内容）' : ''}，此操作不可撤销。`}
          confirmLabel="删除"
          cancelLabel="取消"
          onConfirm={() => void confirmDeleteNow()}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}


