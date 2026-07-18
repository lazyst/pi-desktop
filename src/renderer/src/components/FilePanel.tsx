// File + Git panel. Lives in the app shell between the Sidebar and the main
// terminal area. Two tabs share a single root directory: 📁 文件 (FileTree)
// and 🌿 Git (GitView).
import { useEffect, useMemo, useRef, useState } from 'react';
import { FileTree } from './FileTree';
import { GitView } from './GitView';

type Tab = 'files' | 'git';

interface Props {
  addedDirs: string[];
  activeCwd: string | null;
  onOpenFile: (relPath: string, fileName: string, root: string) => void;
}

export function FilePanel({ addedDirs, activeCwd, onOpenFile }: Props) {
  const [tab, setTab] = useState<Tab>('files');
  // Root directory: default to the active session's cwd, otherwise the first
  // added dir. User can override via the dropdown.
  const candidates = useMemo(() => {
    const set = new Set<string>(addedDirs);
    if (activeCwd) set.add(activeCwd);
    return Array.from(set);
  }, [addedDirs, activeCwd]);

  const [root, setRoot] = useState<string>(activeCwd ?? addedDirs[0] ?? '');

  // Follow the active session: when no explicit override has been made, keep
  // root in sync with the active session's cwd.
  const overrideRef = useRef(false);
  useEffect(() => {
    if (!overrideRef.current && activeCwd) {
      setRoot(activeCwd);
    }
  }, [activeCwd]);
  const onPickRoot = (r: string) => {
    overrideRef.current = true;
    setRoot(r);
  };

  const empty = candidates.length === 0;

  return (
    <div className="file-panel">
      <div className="file-panel-header">
        <div className="file-panel-tabs">
          <button
            type="button"
            className={`fp-tab ${tab === 'files' ? 'active' : ''}`}
            onClick={() => setTab('files')}
          >
            📁 文件
          </button>
          <button
            type="button"
            className={`fp-tab ${tab === 'git' ? 'active' : ''}`}
            onClick={() => setTab('git')}
          >
            🌿 Git
          </button>
        </div>
        {!empty && (
          <select
            className="fp-root-select"
            value={root}
            onChange={(e) => onPickRoot(e.target.value)}
            title="根目录"
          >
            {candidates.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
      </div>

      <div className="file-panel-body">
        {empty ? (
          <div className="file-panel-empty">
            先用 <b>+目录</b> 添加工作目录，即可浏览文件与 Git 状态。
          </div>
        ) : tab === 'files' ? (
          <FileTree root={root} onOpenFile={onOpenFile} />
        ) : (
          <GitView cwd={root} />
        )}
      </div>
    </div>
  );
}
