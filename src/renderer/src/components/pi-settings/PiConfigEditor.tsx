import { useEffect, useState, useRef, useCallback } from 'react';
import { pi } from '../../ipc';

// ─── Pi 配置文件编辑器：表单模式 + 源文件模式 ──────────────────────────

const CONFIG_DEFAULTS: Record<string, unknown> = {
  theme: 'dark',
  hideThinkingBlock: false,
  quietStartup: false,
  showHardwareCursor: false,
  editorPaddingX: 0,
  doubleEscapeAction: 'tree',
  defaultProjectTrust: 'ask',
  'compaction.enabled': true,
  'compaction.reserveTokens': 16384,
  'retry.enabled': true,
  'retry.maxRetries': 3,
  'terminal.showImages': true,
  'terminal.imageWidthCells': 60,
};

interface ConfigData {
  data: unknown;
  raw: string;
  path: string;
  exists: boolean;
}

interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'toggle' | 'select';
  options?: string[];
  placeholder?: string;
}

const CONFIG_GROUPS: Array<{ title: string; fields: FieldDef[] }> = [
  { title: '模型', fields: [
    { key: 'defaultProvider', label: '默认提供者', type: 'text' },
    { key: 'defaultModel', label: '默认模型', type: 'text' },
    { key: 'defaultThinkingLevel', label: '默认思考层级', type: 'select', options: ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
    { key: 'hideThinkingBlock', label: '隐藏思考块', type: 'toggle' },
  ]},
  { title: '界面', fields: [
    { key: 'theme', label: '主题', type: 'select', options: ['dark', 'light'] },
    { key: 'quietStartup', label: '静默启动', type: 'toggle' },
    { key: 'showHardwareCursor', label: '显示硬件光标', type: 'toggle' },
    { key: 'editorPaddingX', label: '编辑器水平内边距', type: 'number', placeholder: '0-3' },
    { key: 'doubleEscapeAction', label: '双 Escape 动作', type: 'select', options: ['tree', 'fork', 'none'] },
    { key: 'defaultProjectTrust', label: '默认项目信任', type: 'select', options: ['ask', 'always', 'never'] },
  ]},
  { title: '压缩', fields: [
    { key: 'compaction.enabled', label: '启用自动压缩', type: 'toggle' },
    { key: 'compaction.reserveTokens', label: '保留 Token 数', type: 'number', placeholder: '16384' },
  ]},
  { title: '重试', fields: [
    { key: 'retry.enabled', label: '启用自动重试', type: 'toggle' },
    { key: 'retry.maxRetries', label: '最大重试次数', type: 'number', placeholder: '3' },
  ]},
  { title: 'Shell / 终端', fields: [
    { key: 'shellPath', label: 'Shell 路径', type: 'text', placeholder: '例如 /bin/bash' },
    { key: 'terminal.showImages', label: '终端显示图片', type: 'toggle' },
    { key: 'terminal.imageWidthCells', label: '图片宽度(单元格)', type: 'number', placeholder: '60' },
  ]},
  { title: '网络 & 会话', fields: [
    { key: 'httpProxy', label: 'HTTP 代理', type: 'text', placeholder: 'http://127.0.0.1:7890' },
    { key: 'sessionDir', label: '会话目录', type: 'text', placeholder: '.pi/sessions' },
    { key: 'enabledModels', label: '启用模型(逗号分隔)', type: 'text', placeholder: 'claude-*, gpt-4o' },
  ]},
];

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!(p in cur) || typeof cur[p] !== 'object' || cur[p] === null) {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

export function PiConfigEditor() {
  const [scope, setScope] = useState<'global' | 'project'>('global');
  const [configData, setConfigData] = useState<ConfigData | null>(null);
  const [tab, setTab] = useState<'form' | 'source'>('form');
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [sourceRaw, setSourceRaw] = useState('');
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [status, setStatus] = useState('加载中...');
  const [saving, setSaving] = useState(false);
  const [readonly, setReadonly] = useState(false);
  const editorRef = useRef<HTMLPreElement>(null);

  const load = useCallback(async () => {
    setStatus('加载中...');
    try {
      const data = await pi.piSettingsGet(scope);
      setConfigData(data);
      setSourceRaw(data.raw);
      setSourceError(null);
      setStatus(data.exists ? '已加载' : '文件不存在');
      // 初始化表单数据
      const formValues: Record<string, string> = {};
      for (const group of CONFIG_GROUPS) {
        for (const field of group.fields) {
          const val = getByPath((data.data || {}) as Record<string, unknown>, field.key);
          formValues[field.key] = val !== undefined ? String(val) : '';
        }
      }
      setFormData(formValues);
    } catch (err) {
      setStatus('加载失败');
    }
  }, [scope]);

  useEffect(() => { load(); }, [load]);

  // 源文件编辑时高亮 JSON
  const highlightJSON = useCallback((text: string): string => {
    return text
      .replace(/("(?:[^"\\]|\\.)*")/g, '<span class="json-string">$1</span>')
      .replace(/<span class="json-string">([^<]+)<\/span>(\s*:)/g, (_, s, c) => {
        return '<span class="json-key">' + s + '</span><span class="json-colon">' + c.trim() + '</span>';
      })
      .replace(/\b(-?\d+\.?\d*(?:[eE][+-]?\d+)?)\b(?!\s*:)/g, '<span class="json-number">$1</span>')
      .replace(/\b(true|false)\b/g, '<span class="json-boolean">$1</span>')
      .replace(/\bnull\b/g, '<span class="json-null">null</span>');
  }, []);

  const handleSourceInput = useCallback(() => {
    if (editorRef.current) {
      const text = editorRef.current.textContent || '';
      setSourceRaw(text);
      setSourceError(null);
    }
  }, []);

  const saveForm = useCallback(async () => {
    setSaving(true);
    setStatus('保存中...');
    try {
      const data: Record<string, unknown> = {};
      for (const group of CONFIG_GROUPS) {
        for (const field of group.fields) {
          let value: unknown = formData[field.key];
          if (field.type === 'number') {
            value = value === '' ? null : Number(value);
          } else if (field.type === 'toggle') {
            value = value === 'true';
          }
          setByPath(data, field.key, value);
        }
      }
      await pi.piSettingsSet({ scope, data });
      setStatus('已保存');
      await load();
    } catch (err) {
      setStatus('保存失败');
    } finally {
      setSaving(false);
    }
  }, [scope, formData, load]);

  const saveSource = useCallback(async () => {
    // 校验 JSON
    try {
      JSON.parse(sourceRaw);
    } catch (e) {
      setSourceError('JSON 格式错误: ' + (e as Error).message);
      return;
    }
    setSourceError(null);
    setSaving(true);
    setStatus('保存中...');
    try {
      await pi.piSettingsSet({ scope, raw: sourceRaw });
      setStatus('已保存');
      await load();
    } catch (err) {
      setStatus('保存失败');
    } finally {
      setSaving(false);
    }
  }, [scope, sourceRaw, load]);

  const handleFieldChange = (key: string, value: string) => {
    setFormData(prev => ({ ...prev, [key]: value }));
  };

  const renderField = (field: FieldDef) => {
    const val = formData[field.key] !== undefined
      ? formData[field.key]
      : String(CONFIG_DEFAULTS[field.key] ?? '');

    if (field.type === 'toggle') {
      const checked = val === 'true';
      return (
        <div className="settings-row" key={field.key}>
          <span className="settings-label">{field.label}</span>
          <label className="pi-toggle">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => handleFieldChange(field.key, e.target.checked ? 'true' : 'false')}
            />
            <span className="pi-toggle-slider" />
            <span className="pi-toggle-text">{checked ? '开启' : '关闭'}</span>
          </label>
        </div>
      );
    }

    if (field.type === 'select') {
      return (
        <div className="settings-row" key={field.key}>
          <span className="settings-label">{field.label}</span>
          <select
            className="pi-select"
            value={val}
            onChange={(e) => handleFieldChange(field.key, e.target.value)}
          >
            {(field.options || []).map(opt => (
              <option key={opt} value={opt}>{opt || '(默认)'}</option>
            ))}
          </select>
        </div>
      );
    }

    const isNum = field.type === 'number';
    return (
      <div className="settings-row" key={field.key}>
        <span className="settings-label">{field.label}</span>
        <input
          type={isNum ? 'number' : 'text'}
          className="pi-input"
          value={val}
          placeholder={field.placeholder || ''}
          onChange={(e) => handleFieldChange(field.key, e.target.value)}
        />
      </div>
    );
  };

  return (
    <div className="pi-settings-editor">
      {/* 工具栏 */}
      <div className="pi-settings-toolbar">
        <div className="pi-settings-toolbar-left">
          <span className="pi-settings-badge">{status}</span>
        </div>
        <div className="pi-settings-toolbar-center">
          <select
            className="pi-select"
            value={scope}
            onChange={(e) => setScope(e.target.value as 'global' | 'project')}
          >
            <option value="global">全局配置 (~/.pi/agent/settings.json)</option>
            <option value="project">项目配置 (.pi/settings.json)</option>
          </select>
        </div>
        <div className="pi-settings-toolbar-right">
          <button className="btn btn-sm" onClick={load}>↻ 刷新</button>
          <button
            className="btn btn-primary btn-sm"
            disabled={saving}
            onClick={tab === 'form' ? saveForm : saveSource}
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>

      {/* 标签切换 */}
      <div className="pi-settings-tabs">
        <button
          className={`pi-settings-tab ${tab === 'form' ? 'active' : ''}`}
          onClick={() => setTab('form')}
        >表单配置</button>
        <button
          className={`pi-settings-tab ${tab === 'source' ? 'active' : ''}`}
          onClick={() => setTab('source')}
        >源文件</button>
      </div>

      {/* 表单模式 */}
      {tab === 'form' && (
        <div className="pi-settings-form">
          {CONFIG_GROUPS.map(group => (
            <div className="pi-config-section" key={group.title}>
              <div className="pi-config-section-title">{group.title}</div>
              <div className="pi-config-section-body">
                {group.fields.map(renderField)}
              </div>
            </div>
          ))}
          {configData?.path && (
            <p className="pi-settings-path">路径: {configData.path}</p>
          )}
        </div>
      )}

      {/* 源文件模式 */}
      {tab === 'source' && (
        <div className="pi-settings-source">
          <div className="pi-source-toolbar">
            <span className="pi-source-path">{configData?.path || ''}</span>
            <div className="pi-source-toolbar-right">
              <button className="btn btn-sm" onClick={() => setReadonly(!readonly)}>
                {readonly ? '编辑' : '只读'}
              </button>
            </div>
          </div>
          <div className="pi-source-editor-wrap">
            <pre
              ref={editorRef}
              className="pi-source-editor"
              contentEditable={!readonly}
              suppressContentEditableWarning
              spellCheck={false}
              onInput={handleSourceInput}
              dangerouslySetInnerHTML={{ __html: highlightJSON(sourceRaw || '{}') }}
            />
          </div>
          {sourceError && <div className="pi-source-error">{sourceError}</div>}
        </div>
      )}
    </div>
  );
}