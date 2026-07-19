import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ============================================================================
// Git read-only bridge
//
// Thin wrapper around `git -C <cwd>` for the desktop app's read-only Git viewer.
// All commands pin LC_ALL=C so error-text / porcelain parsing is locale-stable.
// Non-git directories degrade gracefully (never throw) — callers get
// `{ isGit: false }` and render a "not a git repository" notice.
// ============================================================================

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return stdout;
}

export interface GitStatus {
  isGit: boolean;
  branch: string | null;
  /** Total added lines across working tree (unstaged + staged). */
  additions: number;
  /** Total deleted lines across working tree (unstaged + staged). */
  deletions: number;
  ahead: number;
  behind: number;
  porcelain: string;
}

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
}

/**
 * Status for a working tree. Returns `{ isGit: false }` for non-repos.
 * `porcelain` is the raw `git status --porcelain=v1` output (used to render the
 * working-tree / staged diffs in the UI).
 */
export async function gitStatus(cwd: string): Promise<GitStatus> {
  try {
    const porcelain = await git(cwd, ['status', '--porcelain=v1', '-b', '--untracked-files=normal']);
    const lines = porcelain.split('\n');
    const branchLine = lines[0] ?? '';
    let branch: string | null = null;
    let ahead = 0;
    let behind = 0;
    // ## branch...origin/branch [ahead 1, behind 2]
    const m = branchLine.match(/^##\s+(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/);
    if (m) {
      const ref = m[1];
      branch = ref === 'HEAD (no branch)' ? '(detached)' : ref;
      const meta = m[3] ?? '';
      const a = meta.match(/ahead (\d+)/);
      const b = meta.match(/behind (\d+)/);
      ahead = a ? Number(a[1]) : 0;
      behind = b ? Number(b[1]) : 0;
    }
    // Skip the first line (the `## branch` header); only real file-change
    // lines (tracked modifications, untracked files, etc.) indicate dirtiness.
    const dirty = lines.slice(1).some((l) => l.trim().length > 0);
    // Count added / deleted lines via `git diff --numstat` (unstaged + staged).
    // numstat prints `<additions>\t<deletions>\t<path>` per file; binary or
    // renamed files may show `-` for a count, which we treat as 0.
    const unstagedStat = await git(cwd, ['diff', '--numstat']);
    const stagedStat = await git(cwd, ['diff', '--cached', '--numstat']);
    const sumStat = (out: string): { additions: number; deletions: number } => {
      let additions = 0;
      let deletions = 0;
      for (const line of out.split('\n')) {
        const cols = line.split('\t');
        if (cols.length < 2) continue;
        const a = Number(cols[0]);
        const d = Number(cols[1]);
        additions += Number.isFinite(a) ? a : 0;
        deletions += Number.isFinite(d) ? d : 0;
      }
      return { additions, deletions };
    };
    const u = sumStat(unstagedStat);
    const s = sumStat(stagedStat);
    const additions = u.additions + s.additions;
    const deletions = u.deletions + s.deletions;
    return { isGit: true, branch, additions, deletions, ahead, behind, porcelain };
  } catch {
    return { isGit: false, branch: null, additions: 0, deletions: 0, ahead: 0, behind: 0, porcelain: '' };
  }
}

/** Recent commit log (default 100 entries). */
export async function gitLog(cwd: string, limit = 100): Promise<GitLogEntry[]> {
  try {
    const out = await git(cwd, [
      'log',
      `-n${limit}`,
      '--pretty=format:%H%x1f%an%x1f%ad%x1f%s',
      '--date=iso',
    ]);
    return out
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => {
        const [hash, author, date, ...rest] = l.split('\x1f');
        return { hash, author, date, message: rest.join('\x1f') };
      });
  } catch {
    return [];
  }
}

/**
 * Unified diff text. No `ref` → working tree diff (`git diff` + `--cached`).
 * With `ref` → that commit's diff (`git show <ref>`).
 */
export async function gitDiff(cwd: string, ref?: string): Promise<string> {
  try {
    if (ref) {
      return await git(cwd, ['show', '--no-color', ref]);
    }
    const unstaged = await git(cwd, ['diff', '--no-color']);
    const staged = await git(cwd, ['diff', '--cached', '--no-color']);
    return (unstaged + '\n' + staged).trim() + '\n';
  } catch {
    return '';
  }
}
