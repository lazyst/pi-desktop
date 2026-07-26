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

const GIT_TIMEOUT = 15_000;

async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return stdout;
}

/**
 * 快速检查 cwd 是否在 git 仓库内。
 * 使用 `git rev-parse --git-dir`（极轻量，不扫描工作树），
 * 非 git 目录或超时（3s）时静默返回 false。
 */
async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--git-dir'], 3_000);
    return true;
  } catch {
    return false;
  }
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
  // 先用快速检测判断是否为 git 仓库，避免在非 git 目录下执行完整的
  // git status（可能卡住或等待超时），导致用户看到无限加载中。
  if (!(await isGitRepo(cwd))) {
    return { isGit: false, branch: null, additions: 0, deletions: 0, ahead: 0, behind: 0, porcelain: '' };
  }
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
 * 文件树用 git 状态条目：每个文件/目录的详细 git 状态。
 */
export interface GitFileStatusEntry {
  /** 简化类别，用于 CSS 颜色 */
  category: 'modified' | 'added' | 'deleted' | 'ignored' | 'conflict' | 'submodule';
  /** 是否已暂存（staged） */
  staged: boolean;
  /** 是否工作区有未暂存改动 */
  unstaged: boolean;
  /** 短徽章字母：M/A/D/?/U/R/C/! */
  badge: string;
  /** 是否为符号链接 */
  isSymlink: boolean;
  /** 是否为子模块 */
  isSubmodule: boolean;
  /** 子模块是否有未提交的改动（仅 isSubmodule=true 时有效） */
  submoduleDirty?: boolean;
}

/**
 * 获取被 .gitignore 忽略的顶层路径集合（目录和文件）。
 * 使用 `git status --ignored --short`，输出格式为 `!! <path>`，
 * 目录只列出自身（不含内部文件），输出极简。
 *
 * 在文件树中使用：父目录被忽略则子项全部继承，无需逐文件检查。
 */
export async function gitIgnoredPaths(cwd: string): Promise<string[]> {
  try {
    const out = await git(cwd, ['status', '--ignored', '--short', '--untracked-files=normal']);
    const paths: string[] = [];
    for (const line of out.split('\n')) {
      if (line.startsWith('!! ')) {
        const p = line.slice(3).trim();
        if (p) paths.push(p.endsWith('/') ? p.slice(0, -1) : p);
      }
    }
    return paths;
  } catch {
    return [];
  }
}

/**
 * 文件树用 git 状态映射：返回 { relPath → GitFileStatusEntry }。
 *
 * 包含：
 *   - 工作区状态（modified/added/deleted/conflict）
 *   - staged/unstaged 区分
 *   - 短徽章字母
 *
 * 非 git 目录优雅降级返回空对象。
 */
export async function gitFileStatusMap(cwd: string): Promise<Record<string, GitFileStatusEntry>> {
  try {
    // 只运行 git status（不运行 git ls-files --stage 等额外命令，
    // 避免大仓库中列出所有文件造成 CPU 和内存压力）
    const porcelain = await git(cwd, ['status', '--porcelain=v1', '--untracked-files=normal']);

    const map: Record<string, GitFileStatusEntry> = {};
    for (const line of porcelain.split('\n')) {
      if (!line.trim()) continue;
      const xy = line.substring(0, 2);
      const pathPart = line.substring(3).trim();
      const actualPath = pathPart.includes(' -> ') ? pathPart.split(' -> ')[1].trim() : pathPart;

      const x = xy[0];
      const y = xy[1];
      const staged = x !== ' ' && x !== '?';
      const unstaged = y !== ' ' && y !== '?';

      let category: GitFileStatusEntry['category'];
      let badge: string;

      if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
        category = 'conflict';
        badge = 'U';
      } else if (xy === '??') {
        category = 'added';
        badge = '?';
      } else if (x === 'R' || x === 'C') {
        category = 'modified';
        badge = x;
      } else if (x === 'M' || y === 'M') {
        category = 'modified';
        badge = 'M';
      } else if (x === 'A' || y === 'A') {
        category = 'added';
        badge = 'A';
      } else if (x === 'D' || y === 'D') {
        category = 'deleted';
        badge = 'D';
      } else {
        category = 'modified';
        badge = 'M';
      }

      map[actualPath] = {
        category,
        staged,
        unstaged,
        badge,
        isSymlink: false,
        isSubmodule: false,
      };
    }

    return map;
  } catch {
    return {};
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
