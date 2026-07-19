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
// ⚠️ 集成契约：XtermTerminal 依赖此常量名 + 值不变，拖拽到终端才能解析绝对路径。禁止改名/改值。
export const PI_FILE_DRAG_MIME = 'application/x-pi-file';

/** 由 root + 相对路径算出绝对路径（跨平台分隔符 + . / .. 归一化）。 */
function toAbsolutePath(root: string, relPath: string): string {
  try {
    return nodePath.resolve(root, relPath);
  } catch {
    return relPath ? `${root}/${relPath}` : root;
  }
}

/** 父目录相对路径（'' 表示根）。 */
function parentOf(relPath: string): string {
  if (!relPath.includes('/')) return '';
  return relPath.slice(0, relPath.lastIndexOf('/'));
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

// ─────────────────────────────────────────────────────────────────────────────
// 数据模型层（借鉴 VS Code ExplorerModel / ExplorerItem 思想）
//
// 原实现把「目录的直接子项」存在根层 `roots` state、把「子目录子项」存在各
// TreeNode 自身 state，两套数据源、两套刷新通道（bumpDir 分叉）。重构为单一
// 模型：每个目录节点持有一份已加载的 children 与 loaded 标志，刷新统一走
// model.refresh(relPath)。TreeNode 只负责渲染，不再各自持有数据。
// ─────────────────────────────────────────────────────────────────────────────

interface FileNode {
  name: string;
  fullPath: string; // path relative to the tree root
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

// 目录优先、字母序（借鉴 VS Code FileSorter 的 default 排序：folders first, alphabetical）。
function sortEntries(entries: FileNode[]): FileNode[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

async function fetchEntries(root: string, dirPath: string): Promise<FileNode[]> {
  const entries = await pi.fsListDir(root, dirPath);
  const nodes: FileNode[] = entries.map((e) => ({
    name: e.name,
    fullPath: dirPath ? `${dirPath}/${e.name}` : e.name,
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
  }));
  return sortEntries(nodes);
}

/**
 * 单根文件树模型。借鉴 VS Code ExplorerModel：节点持有缓存的子项，惰性加载，
 * 统一 refresh。本实现保留 React 递归渲染（不引入虚拟列表），仅把数据职责从
 * 渲染组件抽到模型层，使刷新通道唯一、新建伪节点的渲染位置可正确落到父目录内部。
 */
class FileTreeModel {
  private root = '';
  // 目录 fullPath → 已加载的子项（未加载的目录不在此 map 中）。
  private dirChildren = new Map<string, FileNode[]>();
  private dirLoaded = new Set<string>();

  // 版本号：每次 refresh 某目录后自增，TreeNode 据此重新拉取该目录子项。
  // 根层用 '' key，结构同 dirChildren。
  private versions = new Map<string, number>();

  setRoot(root: string): void {
    this.root = root;
  }

  /** 取某目录的当前缓存子项（未加载则为 undefined）。 */
  getChildren(dirPath: string): FileNode[] | undefined {
    return this.dirChildren.get(dirPath);
  }

  isLoaded(dirPath: string): boolean {
    return this.dirLoaded.has(dirPath);
  }

  /** 取当前版本号（用于决定是否需要重载）。 */
  version(dirPath: string): number {
    return this.versions.get(dirPath) ?? 0;
  }

  /** 惰性加载某目录子项；已加载且非强制则直接返回缓存。 */
  async load(dirPath: string, force = false): Promise<FileNode[]> {
    if (!force && this.dirLoaded.has(dirPath)) {
      return this.dirChildren.get(dirPath) ?? [];
    }
    const entries = await fetchEntries(this.root, dirPath);
    this.dirChildren.set(dirPath, entries);
    this.dirLoaded.add(dirPath);
    return entries;
  }

  /**
   * 统一刷新入口（对齐 VS Code ExplorerModel.refresh）。
   * relPath='' 刷新根层；否则刷新指定目录。仅 bump 版本号，真正重载由 TreeNode
   * 在展开/可见时按需触发（keep 原「展开才加载」的惰性语义）。
   */
  refresh(relPath: string): void {
    this.versions.set(relPath, (this.versions.get(relPath) ?? 0) + 1);
  }

  /** 根目录变更：清空全部缓存（新 root 的子项未加载）。 */
  reset(): void {
    this.dirChildren.clear();
    this.dirLoaded.clear();
    this.versions.clear();
  }

  /** 返回根层目录名（用于调试/空态文案，不参与渲染）。 */
  get currentRoot(): string {
    return this.root;
  }
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

// 新建伪节点（尚未落盘的临时子项），渲染在父目录 children 顶部。
interface DraftNode extends FileNode {
  isDraft: true;
}

type TreeNodeProps = {
  node: FileNode;
  depth: number;
  model: FileTreeModel;
  root: string;
  onOpenFile: (relPath: string, fileName: string, root: string) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  selection: Set<string>;
  onToggleSelect: (fullPath: string, e: React.MouseEvent) => void;
  onOpenContextMenu: (e: React.MouseEvent, target: TargetRef | null) => void;
  editing: EditingState | null;
  onCommitEdit: (value: string) => void;
  onCancelEdit: () => void;
  dropTarget: string | null;
  onDragOverDir: (fullPath: string | null) => void;
  onDropOnDir: (fullPath: string) => void;
  onDragStartNodes: (fullPaths: string[], e: React.DragEvent) => void;
  cutRelPaths: Set<string>;
  // 本目录（node 为目录时）下正在新建的伪节点，渲染在 children 顶部。
  draftChild: DraftNode | null;
};

function TreeNode({
  node,
  depth,
  model,
  root,
  onOpenFile,
  expandedPaths,
  onToggleExpanded,
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
  draftChild,
}: TreeNodeProps) {
  const open = expandedPaths.has(node.fullPath);
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);

  // 监听本目录的模型版本：版本变化（refresh 触发）且已展开时重新拉取子项。
  const token = model.version(node.fullPath);

  const loadChildren = useCallback(async (force = false) => {
    if (loaded && !force) return;
    setLoading(true);
    try {
      const entries = await model.load(node.fullPath, force);
      setChildren(entries);
      setLoaded(true);
    } catch {
      // ignore — best-effort tree
    } finally {
      setLoading(false);
    }
  }, [loaded, node.fullPath, model]);

  useEffect(() => {
    if (open && loaded) {
      loadChildren(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

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
      // ⚠️ 集成契约：文件节点点击必须以 (fullPath, name, root) 调 onOpenFile，
      // 否则 CodePreview / FileDrawer 文件预览失效。
      onOpenFile(node.fullPath, node.name, root);
    }
  }, [node.isDir, node.fullPath, node.name, loaded, open, loadChildren, onOpenFile, onToggleExpanded, root, onToggleSelect]);

  // 重命名态：编辑的是本节点自身（伪节点不在此行渲染）。
  const isRenamingHere = editing != null && !editing.isNew && editing.relPath === node.fullPath;

  const className = [
    'file-row',
    selection.has(node.fullPath) ? 'selected' : '',
    cutRelPaths.has(node.fullPath) ? 'cut-pending' : '',
    dropTarget === node.fullPath ? 'drop-target' : '',
    isRenamingHere ? 'editing' : '',
  ].filter(Boolean).join(' ');

  const renderInput = (value: string, isDir: boolean) => (
    <input
      className="file-rename-input"
      autoFocus
      defaultValue={value}
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
  );

  return (
    <div>
      <div
        className={className}
        draggable={!isRenamingHere}
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
        {isRenamingHere ? (
          renderInput(editing!.draftName, false)
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
          {/* 新建伪节点渲染在父目录 children 顶部（修复原 bug：原先覆盖父目录行本身）。 */}
          {draftChild && (
            <div className="file-row editing" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              <span style={{ width: 10, flexShrink: 0 }} />
              <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                {draftChild.isDir ? <FolderIcon size={14} open={false} /> : getFileIcon(draftChild.name, 14)}
              </span>
              {renderInput(draftChild.name, draftChild.isDir)}
            </div>
          )}
          {children.map((child) => (
            <TreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              model={model}
              root={root}
              onOpenFile={onOpenFile}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
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
              draftChild={null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  root: string;
  onOpenFile: (relPath: string, fileName: string, root: string) => void;
  /** Bump to force a refresh of the root layer. (可选；当前调用方未传，向后兼容保留。) */
  refreshKey?: number;
}

export function FileTree({ root, onOpenFile, refreshKey }: Props) {
  // 单一模型实例（借鉴 VS Code ExplorerModel 单例持有 roots）。
  const modelRef = useRef<FileTreeModel>(new FileTreeModel());
  const model = modelRef.current;

  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const prevRootRef = useRef<string | null>(null);

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

  // 统一刷新（对齐 VS Code ExplorerModel.refresh）：根层重拉 roots，子目录 bump 版本。
  const refreshDir = useCallback((relPath: string) => {
    model.refresh(relPath);
    if (relPath === '') {
      const cancelled = { v: false };
      fetchEntries(root, '')
        .then((entries) => { if (!cancelled.v) setRoots(entries); })
        .catch((e) => { if (!cancelled.v) setError(e instanceof Error ? e.message : String(e)); });
      return () => { cancelled.v = true; };
    }
    // 子目录：仅 bump 版本，TreeNode 在展开态自行重载。
    setTreeRefreshKey((k) => k + 1);
  }, [root, model]);

  useEffect(() => {
    const rootChanged = prevRootRef.current !== root;
    prevRootRef.current = root;

    if (rootChanged) {
      model.setRoot(root);
      model.reset();
      setExpandedPaths(new Set());
      setError(null);
      setRoots([]);
      setSelection(new Set());
      setEditing(null);
      setCutRelPaths(new Set());
    }

    if (!root) {
      setLoading(false);
      return;
    }

    setLoading(rootChanged || roots.length === 0);
    setError(null);
    const cancelled = { v: false };
    fetchEntries(root, '')
      .then((entries) => { if (!cancelled.v) setRoots(entries); })
      .catch((e) => { if (!cancelled.v) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled.v) setLoading(false); });
    return () => { cancelled.v = true; };
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

  // ── 新建（inline 伪节点，输完名才落盘）──
  // 新建伪节点渲染在父目录 children 顶部（见 TreeNode draftChild），不再覆盖父目录行。
  const startNew = useCallback((parentRel: string, isDir: boolean) => {
    setSelection(new Set());
    setEditing({ relPath: parentRel, isDir, isNew: true, draftName: isDir ? '新建文件夹' : '新建文件' });
    // 确保父目录展开可见（根 '' 无需展开）。
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
        const siblings = await pi.fsListNames(root, parent);
        const finalName = await pi.fsUniqueName(name, siblings);
        const finalRel = parent ? `${parent}/${finalName}` : finalName;
        if (editing.isDir) await pi.fsMkdir(root, finalRel);
        else await pi.fsCreateFile(root, finalRel, '');
        refreshDir(parent);
        // 对齐 VS Code：新建以用户真实输入的名字一次性落盘（仅一次写盘），
        // 随后直接结束编辑（不进入重命名态）。文件靠 refreshDir(parent) 显示在树里。
        // 根目录（parent===''）无对应 TreeNode 承载重命名 input，行为一致：结束编辑、依赖刷新显示新文件。
        setEditing(null);
      } else {
        const parent = parentOf(editing.relPath);
        const desired = parent ? `${parent}/${name}` : name;
        if (desired === editing.relPath) return;
        const siblings = await pi.fsListNames(root, parent);
        const others = siblings.filter((n) => n !== basename(editing.relPath));
        const finalName = await pi.fsUniqueName(name, others);
        const finalRel = parent ? `${parent}/${finalName}` : finalName;
        await pi.fsRename(root, editing.relPath, finalRel);
        refreshDir(parent);
        if (editing.relPath.includes('/')) {
          refreshDir(parentOf(editing.relPath));
        }
      }
    } catch (e) {
      // 落盘失败：刷新以恢复真实状态
      refreshDir(parentOf(editing.relPath));
      console.error('[file-tree] edit failed', e);
    }
  }, [editing, root, refreshDir]);

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
      refreshDir(destDir);
    } catch (e) {
      console.error('[file-tree] paste failed', e);
    }
  }, [root, refreshDir]);

  // ── 删除 ──
  const requestDelete = useCallback((targets: ClipItem[]) => {
    setMenu(null);
    const hasDirOrMulti = targets.length > 1 || targets.some((t) => t.isDir);
    if (!hasDirOrMulti) {
      void (async () => {
        try {
          await pi.fsRemove(root, targets[0].relPath);
          refreshDir(parentOf(targets[0].relPath));
        } catch (e) { console.error('[file-tree] delete failed', e); }
      })();
      return;
    }
    setConfirmDelete(targets);
  }, [root, refreshDir]);

  const confirmDeleteNow = useCallback(async () => {
    if (!confirmDelete || !root) { setConfirmDelete(null); return; }
    try {
      for (const item of confirmDelete) {
        await pi.fsRemove(root, item.relPath);
        refreshDir(parentOf(item.relPath));
      }
    } catch (e) { console.error('[file-tree] delete failed', e); }
    finally {
      setConfirmDelete(null);
      setSelection(new Set());
    }
  }, [confirmDelete, root, refreshDir]);

  // ── 拖拽（移动 / 复制到目录）──
  // ⚠️ 集成契约：必须保持 PI_FILE_DRAG_MIME 常量 + toAbsolutePath 逻辑不变，
  // 否则拖拽到 XtermTerminal 无法解析成绝对路径。
  const onDragStartNodes = useCallback((fullPaths: string[], e: React.DragEvent) => {
    if (!e.dataTransfer) return;
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
    const moving = selection.size > 0 ? [...selection] : [];
    if (!moving.length) return;
    try {
      for (const rel of moving) {
        const base = basename(rel);
        const siblings = await pi.fsListNames(root, destDir);
        const finalName = await pi.fsUniqueName(base, siblings);
        const destRel = destDir ? `${destDir}/${finalName}` : finalName;
        if (destRel === rel) continue; // 落到自身
        await pi.fsRename(root, rel, destRel);
        refreshDir(parentOf(rel));
      }
      refreshDir(destDir);
      const clip = clipboard.get();
      if (clip?.mode === 'cut') { clipboard.clear(); setCutRelPaths(new Set()); }
    } catch (e) { console.error('[file-tree] move failed', e); }
    setSelection(new Set());
  }, [root, selection, refreshDir]);

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
      // 在目录自身内新建（伪节点渲染在其 children 顶部）。
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
  }, [menu, selection, root, startNew, startRename, doCut, doCopy, doPaste, requestDelete]);

  // 当前右键所在目录（用于空白区新建/粘贴）：若目标是目录则为其本身，否则取其父目录
  const currentDirForMenu = (() => {
    if (!menu) return '';
    if (menu.target == null) return '';
    const { relPath, isDir } = menu.target;
    return isDir ? relPath : parentOf(relPath);
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

  // 根层新建伪节点（relPath===''）：根无对应 TreeNode，故在列表顶部独立渲染一行。
  const rootDraft: DraftNode | null = editing && editing.isNew && editing.relPath === ''
    ? { name: editing.draftName, fullPath: `__draft__${editing.draftName}`, isDir: editing.isDir, size: 0, isDraft: true }
    : null;

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
      {rootDraft && (
        <div className="file-row editing" style={{ paddingLeft: 8 }}>
          <span style={{ width: 10, flexShrink: 0 }} />
          <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            {rootDraft.isDir ? <FolderIcon size={14} open={false} /> : getFileIcon(rootDraft.name, 14)}
          </span>
          <input
            className="file-rename-input"
            autoFocus
            defaultValue={rootDraft.name}
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
          model={model}
          root={root}
          onOpenFile={onOpenFile}
          expandedPaths={expandedPaths}
          onToggleExpanded={handleToggleExpanded}
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
          draftChild={
            editing && editing.isNew && editing.relPath === node.fullPath
              ? { name: editing.draftName, fullPath: `${node.fullPath}/__draft__`, isDir: editing.isDir, size: 0, isDraft: true }
              : null
          }
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
