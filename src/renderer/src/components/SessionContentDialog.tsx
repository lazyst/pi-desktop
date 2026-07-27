import { SessionContentView } from './SessionContentView';

interface Props {
  sessionKey: string;
  sessionName: string;
  onClose: () => void;
}

export function SessionContentDialog({ sessionKey, sessionName, onClose }: Props) {
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
          <SessionContentView sessionKey={sessionKey} sessionName={sessionName} />
        </div>
      </div>
    </div>
  );
}