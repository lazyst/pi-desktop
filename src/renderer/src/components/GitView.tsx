// Read-only Git viewer. Shows branch + dirty status, recent commit log (click a
// commit to see its diff), and the working-tree diff (unstaged + staged).
// All data comes from the `git:status` / `git:log` / `git:diff` IPC channels,
// which degrade gracefully for non-git directories. Ported concept from plan
// M5 (G1). No push / commit / checkout — read only.
import { useCallback, useEffect, useState } from 'react';
import { pi } from '../ipc';
import { SplitDiffView } from './SplitDiffView';

interface LogEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
}

interface Props {
  cwd: string;
}

export function GitView({ cwd }: Props) {
  const [status, setStatus] = useState<{ isGit: boolean; branch: string | null; dirty: boolean; ahead: number; behind: number } | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [commitDiff, setCommitDiff] = useState<string>('');
  const [workDiff, setWorkDiff] = useState<string>('');
  const [loadingDiff, setLoadingDiff] = useState(false);

  const refresh = useCallback(async () => {
    if (!cwd) { setStatus(null); setLog([]); return; }
    try {
      const s = await pi.gitStatus(cwd);
      setStatus({ isGit: s.isGit, branch: s.branch, dirty: s.dirty, ahead: s.ahead, behind: s.behind });
      if (s.isGit) {
        const l = await pi.gitLog(cwd, 100);
        setLog(l);
        const wd = await pi.gitDiff(cwd);
        setWorkDiff(wd);
      } else {
        setLog([]);
        setWorkDiff('');
      }
    } catch {
      setStatus({ isGit: false, branch: null, dirty: false, ahead: 0, behind: 0 });
      setLog([]);
      setWorkDiff('');
    }
  }, [cwd]);

  useEffect(() => {
    setSelectedHash(null);
    setCommitDiff('');
    void refresh();
  }, [refresh]);

  const onSelectCommit = useCallback(async (hash: string) => {
    setSelectedHash(hash);
    setLoadingDiff(true);
    try {
      const d = await pi.gitDiff(cwd, hash);
      setCommitDiff(d);
    } catch {
      setCommitDiff('');
    } finally {
      setLoadingDiff(false);
    }
  }, [cwd]);

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
        {status.dirty && <span className="git-dirty" title="工作区有改动">● 改动</span>}
      </div>

      <div className="git-section-title">提交历史</div>
      <div className="git-log">
        {log.length === 0 && <div className="git-empty">无提交</div>}
        {log.map((e) => (
          <div
            key={e.hash}
            className={`git-log-item ${selectedHash === e.hash ? 'active' : ''}`}
            onClick={() => void onSelectCommit(e.hash)}
            title={`${e.hash}\n${e.author} · ${e.date}`}
          >
            <span className="git-log-msg">{e.message}</span>
            <span className="git-log-meta">{e.author}</span>
          </div>
        ))}
      </div>

      <div className="git-section-title">工作区改动</div>
      <div className="git-diff">
        {loadingDiff ? (
          <div className="git-empty">加载 diff…</div>
        ) : selectedHash ? (
          <SplitDiffView text={commitDiff} />
        ) : (
          (workDiff.trim() ? <SplitDiffView text={workDiff} /> : <div className="git-empty">无改动</div>)
        )}
      </div>
    </div>
  );
}
