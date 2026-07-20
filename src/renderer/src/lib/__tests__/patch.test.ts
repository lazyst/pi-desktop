import { describe, it, expect } from 'vitest';
import { parseUnifiedPatch, reconstructDiffSides } from '../patch';

describe('parseUnifiedPatch', () => {
  it('returns null for empty input', () => {
    expect(parseUnifiedPatch('')).toBeNull();
    expect(parseUnifiedPatch('not a diff')).toBeNull();
  });

  it('parses an added file (all + lines)', () => {
    const text = [
      '--- /dev/null',
      '+++ b/foo.ts',
      '@@ -0,0 +1,3 @@',
      '+line one',
      '+line two',
      '+line three',
    ].join('\n');
    const files = parseUnifiedPatch(text);
    expect(files).not.toBeNull();
    expect(files!.length).toBe(1);
    expect(files![0].newPath).toBe('b/foo.ts');
    // 3 added lines, no context
    const added = files![0].rows.filter((r) => r.type === 'line' && r.right.type === 'added');
    expect(added.length).toBe(3);
  });

  it('parses a modified file with context + removed + added', () => {
    const text = [
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,4 +1,4 @@',
      ' context a',
      '-removed line',
      '+added line',
      ' context b',
    ].join('\n');
    const files = parseUnifiedPatch(text);
    expect(files).not.toBeNull();
    const rows = files![0].rows.filter((r) => r.type === 'line');
    expect(rows.length).toBe(3);
    // A removed line immediately followed by an added line is paired into a single
    // row (left=removed, right=added) by flushChanges.
    const paired = rows[1];
    if (paired.type === 'line') {
      expect(paired.left.type).toBe('removed');
      expect(paired.right.type).toBe('added');
    }
    // first row: context on both sides
    const ctx = rows[0];
    if (ctx.type === 'line') {
      expect(ctx.left.type).toBe('context');
      expect(ctx.right.type).toBe('context');
      expect(ctx.left.lineNo).toBe(1);
    }
    // second row: removed+added paired (left=same old lineNo? no — removed bumps old)
    const removed = rows[1];
    if (removed.type === 'line') {
      expect(removed.left.type).toBe('removed');
      expect(removed.right.type).toBe('added');
    }
    // third row: context on both sides again
    const added = rows[2];
    if (added.type === 'line') {
      expect(added.left.type).toBe('context');
      expect(added.right.type).toBe('context');
    }
  });

  it('tracks correct line numbers across hunks', () => {
    const text = [
      '--- a/x',
      '+++ b/x',
      '@@ -1,1 +1,1 @@',
      ' a',
      '@@ -10,1 +10,2 @@',
      ' j',
      '+k',
    ].join('\n');
    const files = parseUnifiedPatch(text);
    expect(files).not.toBeNull();
    const firstLine = files![0].rows.find((r) => r.type === 'line');
    if (firstLine && firstLine.type === 'line') {
      expect(firstLine.left.lineNo).toBe(1);
      expect(firstLine.right.lineNo).toBe(1);
    }
    const lastLine = files![0].rows.filter((r) => r.type === 'line').pop();
    if (lastLine && lastLine.type === 'line') {
      // old side jumps to line 10, new side to 10 then +1 → added is line 11
      expect(lastLine.left.type).toBe('empty');
      expect(lastLine.right.lineNo).toBe(11);
    }
  });

  it('handles a diff with no line changes', () => {
    const text = [
      '--- a/x',
      '+++ b/x',
      '@@ -1,1 +1,1 @@',
      ' same',
    ].join('\n');
    // only context → rows have lines but no added/removed; should still parse
    const files = parseUnifiedPatch(text);
    expect(files).not.toBeNull();
    expect(files!.length).toBe(1);
  });
});

describe('reconstructDiffSides', () => {
  it('returns empty sides when nothing parses', () => {
    expect(reconstructDiffSides('')).toEqual({ original: '', modified: '' });
    expect(reconstructDiffSides('not a diff')).toEqual({ original: '', modified: 'not a diff' });
  });

  it('reconstructs original/modified for a modified file', () => {
    const text = [
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,4 +1,4 @@',
      ' context a',
      '-removed line',
      '+added line',
      ' context b',
    ].join('\n');
    const { original, modified } = reconstructDiffSides(text);
    // original：上下文 + 删除行，无新增行
    expect(original).toContain('context a');
    expect(original).toContain('removed line');
    expect(original).toContain('context b');
    expect(original).not.toContain('added line');
    // modified：上下文 + 新增行，无删除行
    expect(modified).toContain('context a');
    expect(modified).toContain('added line');
    expect(modified).toContain('context b');
    expect(modified).not.toContain('removed line');
  });

  it('separates multiple files with boundary markers', () => {
    const text = [
      'diff --git a/one b/one',
      '--- a/one',
      '+++ b/one',
      '@@ -1 +1 @@',
      '+one added',
      'diff --git a/two b/two',
      '--- a/two',
      '+++ b/two',
      '@@ -1 +1 @@',
      '+two added',
    ].join('\n');
    const { original, modified } = reconstructDiffSides(text);
    expect(original).toContain('===== b/one (original) =====');
    expect(original).toContain('===== b/two (original) =====');
    expect(modified).toContain('===== b/one (modified) =====');
    expect(modified).toContain('===== b/two (modified) =====');
    expect(modified).toContain('one added');
    expect(modified).toContain('two added');
  });
});
