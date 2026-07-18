// Lazy file tree. Ported from pi-web/components/FileExplorer.tsx — the tree
// logic (lazy-load dirs, expand/collapse, icons, click-to-open) is preserved,
// but directory listing now goes through the `fs:listDir` IPC and the
// web-only upload / @mention affordances are removed.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getFileIcon, FolderIcon } from './FileIcons';
import { pi } from '../ipc';
import * as nodePath from 'node:path';

// 文件树 → 终端拖拽使用的自定义 MIME（区别于系统文件管理器的 'Files'）。
// XtermTerminal.bindDragAndDrop 同时识别该类型，实现「从内部文件树拖文件到终端即插入绝对路径」。
export const PI_FILE_DRAG_MIME = 'application/x-pi-file';

/** 由 root + 相对路径算出绝对路径（跨平台分隔符 + . / .. 归一化）。 */
function toAbsolutePath(root: string, relPath: string): string {
  try {
    return nodePath.resolve(root, relPath);
  } catch {
    // 极端情况兜底：直接拼接（Electron 渲染进程 node:path 几乎不会抛）。
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

function TreeNode({
  node,
  depth,
  root,
  onOpenFile,
  expandedPaths,
  onToggleExpanded,
  refreshToken,
}: {
  node: FileNode;
  depth: number;
  root: string;
  onOpenFile: (relPath: string, fileName: string, root: string) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshToken: string;
}) {
  const open = expandedPaths.has(node.fullPath);
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);

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

  const handleClick = useCallback(() => {
    if (node.isDir) {
      const next = !open;
      onToggleExpanded(node.fullPath, next);
      if (next && !loaded) loadChildren();
    } else {
      onOpenFile(node.fullPath, node.name, root);
    }
  }, [node.isDir, node.fullPath, node.name, loaded, open, loadChildren, onOpenFile, onToggleExpanded, root]);

  // 拖拽整行到终端：写入绝对路径到自定义 MIME（终端侧识别并粘贴为路径）。
  // 文件与文件夹都支持（文件夹拖入即目录路径）。
  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer) return;
    const abs = toAbsolutePath(root, node.fullPath);
    e.dataTransfer.setData(PI_FILE_DRAG_MIME, abs);
    e.dataTransfer.setData('text/plain', abs);
    e.dataTransfer.effectAllowed = 'copy';
  }, [root, node.fullPath]);

  return (
    <div>
      <div
        className="file-row"
        draggable
        onClick={handleClick}
        onDragStart={handleDragStart}
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
        <span className="file-name" title={node.fullPath}>{node.name}</span>
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
              refreshToken={refreshToken}
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
  const prevRootRef = useRef<string | null>(null);
  const refreshToken = `${refreshKey ?? 0}:${treeRefreshKey}`;

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  useEffect(() => {
    const rootChanged = prevRootRef.current !== root;
    prevRootRef.current = root;

    if (rootChanged) {
      setExpandedPaths(new Set());
      setError(null);
      setRoots([]);
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
  }, [root, refreshKey, treeRefreshKey]);

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
    return <div className="file-empty">空目录</div>;
  }

  return (
    <div className="file-tree">
      {roots.map((node) => (
        <TreeNode
          key={node.fullPath}
          node={node}
          depth={0}
          root={root}
          onOpenFile={onOpenFile}
          expandedPaths={expandedPaths}
          onToggleExpanded={handleToggleExpanded}
          refreshToken={refreshToken}
        />
      ))}
    </div>
  );
}
