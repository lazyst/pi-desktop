import { useEffect, useState, useCallback } from 'react';
import { pi } from '../../ipc';
import { ConfirmDialog } from '../ConfirmDialog';

// ─── Skills 管理组件 ───────────────────────────────────────────────────

interface SkillInfo {
  name: string;
  disabled: boolean;
  description?: string;
}

export function PiSkillsManager() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [tab, setTab] = useState<'enabled' | 'disabled'>('enabled');
  const [status, setStatus] = useState('加载中...');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus('加载中...');
    try {
      const data = await pi.piSkillsList();
      setSkills(data.skills);
      setStatus(`${data.skills.length} 个`);
    } catch (err) {
      setStatus('加载失败');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const disable = async (name: string) => {
    try {
      const res = await pi.piSkillsDisable(name);
      if (res.success) {
        await load();
      }
    } catch (err) {
      // ignore
    }
  };

  const enable = async (name: string) => {
    try {
      const res = await pi.piSkillsEnable(name);
      if (res.success) {
        await load();
      }
    } catch (err) {
      // ignore
    }
  };

  const doDelete = async (name: string) => {
    setConfirmDelete(null);
    try {
      const res = await pi.piSkillsDelete(name);
      if (res.success) {
        await load();
      }
    } catch (err) {
      // ignore
    }
  };

  const filtered = skills.filter(s => tab === 'disabled' ? s.disabled : !s.disabled);

  return (
    <div className="pi-skills-manager">
      <div className="pi-skills-toolbar">
        <span className="pi-settings-badge">{status}</span>
        <button className="btn btn-sm" onClick={load}>↻ 刷新</button>
      </div>

      <div className="pi-skills-tabs">
        <button className={`pi-tab ${tab === 'enabled' ? 'active' : ''}`} onClick={() => setTab('enabled')}>已启用</button>
        <button className={`pi-tab ${tab === 'disabled' ? 'active' : ''}`} onClick={() => setTab('disabled')}>已禁用</button>
      </div>

      <div className="pi-skills-list">
        {filtered.length === 0 && (
          <div className="pi-empty-state">
            <p>{tab === 'disabled' ? '暂无已禁用的 Skill' : '暂无已启用的 Skill'}</p>
          </div>
        )}
        {filtered.map(s => (
          <div className="pi-skill-card" key={s.name}>
            <div className="pi-skill-card-header">
              <span className="pi-skill-name">{s.name}</span>
              <span className={`pi-skill-badge ${s.disabled ? 'pi-badge-disabled' : 'pi-badge-enabled'}`}>
                {s.disabled ? '已禁用' : '正常'}
              </span>
            </div>
            <div className="pi-skill-desc">
              {s.description || <span className="pi-muted">无描述</span>}
            </div>
            <div className="pi-skill-actions">
              {s.disabled ? (
                <>
                  <button className="btn btn-sm" onClick={() => enable(s.name)}>启用</button>
                  <button className="btn btn-sm btn-danger" onClick={() => setConfirmDelete(s.name)}>删除</button>
                </>
              ) : (
                <>
                  <button className="btn btn-sm" onClick={() => disable(s.name)}>禁用</button>
                  <button className="btn btn-sm btn-danger" onClick={() => setConfirmDelete(s.name)}>删除</button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="删除 Skill"
          message={`确定要永久删除 Skill「${confirmDelete}」吗？此操作不可撤销。`}
          onConfirm={() => doDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}