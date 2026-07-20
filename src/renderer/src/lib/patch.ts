// Pure-function unified-diff parser. Ported verbatim from pi-web/lib/patch.ts.
export type SplitDiffCellType = 'context' | 'removed' | 'added' | 'empty';

export interface SplitDiffCell {
  lineNo: number | null;
  text: string;
  type: SplitDiffCellType;
}

export type SplitDiffRow =
  | { type: 'hunk'; text: string }
  | { type: 'line'; left: SplitDiffCell; right: SplitDiffCell };

export interface SplitDiffFile {
  oldPath?: string;
  newPath?: string;
  rows: SplitDiffRow[];
}

interface PendingChangeLine {
  lineNo: number;
  text: string;
}

export function parseUnifiedPatch(text: string): SplitDiffFile[] | null {
  const files: SplitDiffFile[] = [];
  let current: SplitDiffFile | null = null;
  let pendingOldPath: string | undefined;
  let oldLineNo = 0;
  let newLineNo = 0;
  let removed: PendingChangeLine[] = [];
  let added: PendingChangeLine[] = [];

  const emptyCell = (): SplitDiffCell => ({ lineNo: null, text: '', type: 'empty' });
  const flushChanges = () => {
    if (!current) {
      removed = [];
      added = [];
      return;
    }
    const count = Math.max(removed.length, added.length);
    for (let i = 0; i < count; i++) {
      const left = removed[i]
        ? { lineNo: removed[i].lineNo, text: removed[i].text, type: 'removed' as const }
        : emptyCell();
      const right = added[i]
        ? { lineNo: added[i].lineNo, text: added[i].text, type: 'added' as const }
        : emptyCell();
      current.rows.push({ type: 'line', left, right });
    }
    removed = [];
    added = [];
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('--- ')) {
      flushChanges();
      pendingOldPath = cleanPatchPath(line.slice(4));
      continue;
    }

    if (line.startsWith('+++ ')) {
      flushChanges();
      current = { oldPath: pendingOldPath, newPath: cleanPatchPath(line.slice(4)), rows: [] };
      files.push(current);
      continue;
    }

    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      if (!current) {
        current = { rows: [] };
        files.push(current);
      }
      flushChanges();
      oldLineNo = Number(hunk[1]);
      newLineNo = Number(hunk[2]);
      current.rows.push({ type: 'hunk', text: line });
      continue;
    }

    if (!current) continue;

    if (line.startsWith('\\ ')) {
      flushChanges();
      current.rows.push({ type: 'hunk', text: line });
      continue;
    }

    const prefix = line[0];
    const content = line.slice(1);

    if (prefix === ' ') {
      flushChanges();
      current.rows.push({
        type: 'line',
        left: { lineNo: oldLineNo++, text: content, type: 'context' },
        right: { lineNo: newLineNo++, text: content, type: 'context' },
      });
    } else if (prefix === '-') {
      removed.push({ lineNo: oldLineNo++, text: content });
    } else if (prefix === '+') {
      added.push({ lineNo: newLineNo++, text: content });
    } else if (line !== '') {
      flushChanges();
      current.rows.push({ type: 'hunk', text: line });
    }
  }

  flushChanges();

  const parsed = files.filter((file) => file.rows.some((row) => row.type === 'line'));
  return parsed.length > 0 ? parsed : null;
}

function cleanPatchPath(path: string): string {
  return path.split('\t')[0].trim();
}

/**
 * 把 unified patch 文本重建成 Monaco diff 需要的 original/modified 两份完整文本。
 * 遍历所有文件：删除行（-）只进 original；新增行（+）只进 modified；上下文行（ ）
 * 两侧都进（行内容相同，保证对齐）；hunk 头/文件元数据头不计入内容。
 * 多文件场景下，在每个文件两侧插入同名分隔标记，便于在单文档 diff 中辨识边界
 * （标记行内容一致，Monaco 视为未改动 context）。
 *
 * 用于把 git 的 unified diff 喂给 MonacoDiffEditor（其输入是两份完整文本、由内部算
 * 行内差异），替代自研 SplitDiffView 的 unified 单栏解析。
 * 无法解析时回退：original 为空、modified 为整段原文（整段呈现为新增）。
 */
export function reconstructDiffSides(text: string): { original: string; modified: string } {
  const files = parseUnifiedPatch(text);
  if (!files) {
    return { original: '', modified: text };
  }
  const originalParts: string[] = [];
  const modifiedParts: string[] = [];
  for (const file of files) {
    const name = file.newPath || file.oldPath || '（未命名文件）';
    originalParts.push(`===== ${name} (original) =====`);
    modifiedParts.push(`===== ${name} (modified) =====`);
    for (const row of file.rows) {
      if (row.type === 'hunk') continue; // hunk/元数据头不计入内容
      const { left, right } = row;
      if (left.type === 'removed' || left.type === 'context') {
        originalParts.push(left.text);
      }
      if (right.type === 'added' || right.type === 'context') {
        modifiedParts.push(right.text);
      }
    }
  }
  return { original: originalParts.join('\n'), modified: modifiedParts.join('\n') };
}
