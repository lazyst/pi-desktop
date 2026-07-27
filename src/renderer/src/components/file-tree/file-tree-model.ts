// ─────────────────────────────────────────────────────────────────────────────
// 文件树数据模型（借鉴 VS Code ExplorerModel / ExplorerItem 思想）
//
// 单根模型：每个目录节点持有一份已加载的 children 与 loaded 标志，刷新统一走
// model.refresh(relPath)。TreeNode 只负责渲染，不再各自持有数据。
// ─────────────────────────────────────────────────────────────────────────────

import * as nodePath from 'node:path';
import { pi } from '../../ipc';
import type { FileNode } from './file-tree-types';

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

export class FileTreeModel {
  private root = '';
  // 目录 fullPath → 已加载的子项（未加载的目录不在此 map 中）。
  private dirChildren = new Map<string, FileNode[]>();
  private dirLoaded = new Set<string>();

  // 版本号：每次 refresh 某目录后自增，调用方据此重新拉取该目录子项。
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
   * relPath='' 刷新根层；否则刷新指定目录。仅 bump 版本号，真正重载由调用方
   * 在展开/可见时按需触发（保持「展开才加载」的惰性语义）。
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

export { fetchEntries, sortEntries };