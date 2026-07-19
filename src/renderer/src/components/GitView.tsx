// Read-only Git viewer. Shows branch + change counts, recent commit log (click a
// commit to open its diff in the right-side drawer), and a "工作区改动" header
// (click to open the working-tree diff in the right-side drawer).
// All data comes from the `git:status` / `git:log` / `git:diff` IPC channels,
// which degrade gracefully for non-git directories. Ported concept from plan
// M5 (G1). No push / commit / checkout — read only.
import { useCallback, useEffect, useState } from 'react';
import { pi } from '../ipc';

interface LogEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
}

interface Props {
  cwd: string;
  /** Open the working-tree diff in the right-side drawer. */
  onOpenWorkDiff: (cwd: string) => void;
  /** Open a single commit's diff in the right-side drawer. */
  onOpenCommit: (cwd: string, hash: string) => void;
}

export function GitView({ cwd, onOpenWorkDiff, onOpenCommit }: Props) {
  const [status, setStatus] = useState<{ isGit: boolean; branch: string | null; additions: number; deletions: number; ahead: number; behind: number } | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  const refresh = useCallback(async () => {
    if (!cwd) { setStatus(null); setLog([]); return; }
    try {
      const s = await pi.gitStatus(cwd);
      setStatus({ isGit: s.isGit, branch: s.branch, additions: s.additions, deletions: s.deletions, ahead: s.ahead, behind: s.behind });
      if (s.isGit) {
        const l = await pi.gitLog(cwd, 100);
        setLog(l);
      } else {
        setLog([]);
      }
    } catch {
      setStatus({ isGit: false, branch: null, additions: 0, deletions: 0, ahead: 0, behind: 0 });
      setLog([]);
    }
  }, [cwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!status) {
    return <div className="git-empty">加载中…</div>;
  }
  if (!status.isGit) {
    return <div className="git-empty">不是 Git 仓库：{cwd}</div>;
  }

  return (
    <div className="git-view">
      <div className="git-branch-row">
        <span className="git-branch" title={status.branch ?? ''}>🌿 {status.branch ?? '(detached)'}</span>
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="git-ahead-behind">
            {status.ahead > 0 && <span className="git-ahead">↑{status.ahead}</span>}
            {status.behind > 0 && <span className="git-behind">↓{status.behind}</span>}
          </span>
        )}
        {(status.additions > 0 || status.deletions > 0) && (
          <span className="git-changes" title="工作区改动行数">
            {status.additions > 0 && <span className="git-add">+{status.additions}</span>}
            {status.deletions > 0 && <span className="git-del">−{status.deletions}</span>}
          </span>
        )}
      </div>

      <div className="git-section-title">提交历史</div>
      <div className="git-log">
        {log.length === 0 && <div className="git-empty">无提交</div>}
        {log.map((e) => (
          <div
            key={e.hash}
            className="git-log-item"
            onClick={() => onOpenCommit(cwd, e.hash)}
            title={`${e.hash}\n${e.author} · ${e.date}\n点击在右侧抽屉查看改动`}
          >
            <span className="git-log-msg">{e.message}</span>
            <span className="git-log-meta">{e.author}</span>
          </div>
        ))}
      </div>

      <div
        className="git-section-title git-section-clickable"
        onClick={() => onOpenWorkDiff(cwd)}
        title="在右侧抽屉查看工作区改动"
      >
        工作区改动
        {(status.additions > 0 || status.deletions > 0) && (
          <span className="git-changes" title="工作区改动行数">
            {status.additions > 0 && <span className="git-add">+{status.additions}</span>}
            {status.deletions > 0 && <span className="git-del">−{status.deletions}</span>}
          </span>
        )}
        <span className="git-open-hint">查看 →</span>
      </div>
    </div>
  );
}
