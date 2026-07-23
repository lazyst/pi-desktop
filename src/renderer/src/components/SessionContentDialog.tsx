import { useEffect, useState } from 'react';
import { pi } from '../ipc';

interface SessionMessage {
  role: string;
  content: string;
  toolName?: string;
}

interface Props {
  sessionKey: string;
  sessionName: string;
  onClose: () => void;
}

const ROLE_LABEL: Record<string, string> = {
  user: '用户',
  assistant: 'Pi',
  system: '系统',
  tool: '工具调用',
};

const ROLE_ICON: Record<string, string> = {
  user: '👤',
  assistant: '🤖',
  system: '⚙',
  tool: '🔧',
};

export function SessionContentDialog({ sessionKey, sessionName, onClose }: Props) {
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 工具调用折叠状态：key 为消息索引，true=展开
  const [expandedTools, setExpandedTools] = useState<Record<number, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    pi.readSessionContent(sessionKey)
      .then((msgs) => {
        if (!cancelled) setMessages(msgs);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [sessionKey]);

  const toggleTool = (idx: number) => {
    setExpandedTools((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="session-content-modal"
        role="dialog"
        aria-label={`会话: ${sessionName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="session-content-header">
          <span className="session-content-title" title={sessionName}>
            💬 {sessionName}
          </span>
          <button className="icon-btn" type="button" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="session-content-body">
          {loading && <div className="empty-state">加载中...</div>}
          {error && <div className="error-state">⚠ {error}</div>}
          {!loading && !error && messages.length === 0 && (
            <div className="empty-state">会话内容为空</div>
          )}
          {messages.map((msg, i) => {
            const isTool = msg.role === 'tool';
            const isExpanded = !!expandedTools[i];
            return (
              <div key={i} className={`session-msg session-msg-${msg.role}${isTool ? ' session-msg-tool' : ''}${isTool && isExpanded ? ' expanded' : ''}`}
                onClick={isTool ? () => toggleTool(i) : undefined}
                role={isTool ? 'button' : undefined}
                tabIndex={isTool ? 0 : undefined}
                onKeyDown={isTool ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTool(i); } } : undefined}
                aria-expanded={isTool ? isExpanded : undefined}
                aria-label={isTool ? (isExpanded ? `收起工具调用 ${msg.toolName}` : `展开工具调用 ${msg.toolName}`) : undefined}
                title={isTool ? (isExpanded ? '收起' : '展开') : undefined}
              >
                {isTool ? (
                  <>
                    <div className="session-msg-tool-line">
                      <span className="tool-label">tool</span>
                      <span className="tool-name">[{msg.toolName ?? '?'}]</span>
                      <span className="tool-arrow">{isExpanded ? '▼' : '>'}</span>
                    </div>
                    {isExpanded && (
                      <div className="session-msg-content">
                        {msg.content || <span className="text-faint">等待结果...</span>}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="session-msg-role">
                      {ROLE_ICON[msg.role] ?? '📄'} {ROLE_LABEL[msg.role] ?? msg.role}
                      {msg.toolName && <span className="session-msg-tool-name"> — {msg.toolName}</span>}
                    </div>
                    <div className="session-msg-content">
                      {msg.role === 'tool' && !msg.content ? (
                        <span className="text-faint">等待结果...</span>
                      ) : (
                        msg.content
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}