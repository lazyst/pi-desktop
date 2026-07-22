import { useEffect, useState, useCallback } from 'react';
import { pi } from '../../ipc';

// ─── MCP 管理组件 ──────────────────────────────────────────────────────

interface McpFile {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  config: { mcpServers?: Record<string, McpServer>; settings?: Record<string, unknown>; imports?: string[] } | null;
}

interface McpServer {
  command?: string;
  args?: string[];
  url?: string;
  cwd?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  auth?: string;
  bearerToken?: string;
  lifecycle?: string;
  idleTimeout?: number;
  directTools?: boolean | string[];
  excludeTools?: string[];
  exposeResources?: boolean;
  debug?: boolean;
  oauth?: { grantType?: string; clientId?: string; clientSecret?: string; scope?: string };
}

export function PiMcpManager() {
  const [files, setFiles] = useState<McpFile[]>([]);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [mcpVersion, setMcpVersion] = useState<string | undefined>();
  const [status, setStatus] = useState('检测中...');
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setStatus('检测中...');
    try {
      const statusData = await pi.piMcpStatus();
      setInstalled(statusData.installed);
      setMcpVersion(statusData.version);
      if (statusData.installed) {
        const configs = await pi.piMcpConfigs();
        setFiles(configs as McpFile[]);
        setStatus('已加载');
      } else {
        setFiles([]);
        setStatus('未安装');
      }
    } catch (err) {
      setStatus('检测失败');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleFile = (fIdx: number) => {
    const key = `file-${fIdx}`;
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleSection = (section: string) => {
    setExpanded(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const updateFile = (fIdx: number, updater: (f: McpFile) => McpFile) => {
    setFiles(prev => {
      const next = [...prev];
      next[fIdx] = updater(next[fIdx]);
      return next;
    });
  };

  const saveFile = async (fIdx: number) => {
    const file = files[fIdx];
    setSaving(prev => ({ ...prev, [fIdx]: true }));
    try {
      await pi.piMcpConfigsSave({ id: file.id, config: file.config || {} });
      await load();
    } finally {
      setSaving(prev => ({ ...prev, [fIdx]: false }));
    }
  };

  const addServer = (fIdx: number) => {
    updateFile(fIdx, (f) => ({
      ...f,
      exists: true,
      config: { ...f.config, mcpServers: { ...(f.config?.mcpServers || {}), [`new-server-${Date.now()}`]: { command: '', args: [] } } },
    }));
  };

  const removeServer = (fIdx: number, sKey: string) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      delete servers[sKey];
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  const updateServer = (fIdx: number, sKey: string, field: string, value: unknown) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      servers[sKey] = { ...(servers[sKey] || {}), [field]: value };
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  const addServerArg = (fIdx: number, sKey: string) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const server = { ...(servers[sKey] || {}) };
      server.args = [...(server.args || []), ''];
      servers[sKey] = server;
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  const updateServerArg = (fIdx: number, sKey: string, idx: number, value: string) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const server = { ...(servers[sKey] || {}) };
      const args = [...(server.args || [])];
      args[idx] = value;
      server.args = args;
      servers[sKey] = server;
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  const removeServerArg = (fIdx: number, sKey: string, idx: number) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const server = { ...(servers[sKey] || {}) };
      server.args = (server.args || []).filter((_, i) => i !== idx);
      servers[sKey] = server;
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  const addEnv = (fIdx: number, sKey: string) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const server = { ...(servers[sKey] || {}) };
      server.env = { ...(server.env || {}), [`KEY_${Date.now()}`]: '' };
      servers[sKey] = server;
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  const updateEnv = (fIdx: number, sKey: string, oldKey: string, newKey: string, value: string) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const server = { ...(servers[sKey] || {}) };
      const env = { ...(server.env || {}) };
      if (oldKey !== newKey) {
        delete env[oldKey];
        env[newKey] = value;
      } else {
        env[oldKey] = value;
      }
      server.env = env;
      servers[sKey] = server;
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  const removeEnv = (fIdx: number, sKey: string, key: string) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const server = { ...(servers[sKey] || {}) };
      const env = { ...(server.env || {}) };
      delete env[key];
      server.env = env;
      servers[sKey] = server;
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  const renderServerCard = (fIdx: number, sKey: string, server: McpServer) => {
    const isStdio = !!server.command;
    return (
      <div className="pi-mcp-server" key={sKey}>
        <div className="pi-mcp-server-header">
          <span className="pi-mcp-server-name">{sKey}</span>
          <button className="pi-btn-danger" onClick={() => removeServer(fIdx, sKey)}>删除</button>
        </div>
        <div className="pi-mcp-server-body">
          <div className="pi-field-row">
            <label>传输方式</label>
            <select className="pi-select" value={isStdio ? 'stdio' : 'http'}
              onChange={e => {
                const isStdio = e.target.value === 'stdio';
                if (isStdio) {
                  updateServer(fIdx, sKey, 'command', '');
                  updateServer(fIdx, sKey, 'args', []);
                  updateServer(fIdx, sKey, 'url', undefined);
                  updateServer(fIdx, sKey, 'headers', undefined);
                  updateServer(fIdx, sKey, 'auth', undefined);
                } else {
                  updateServer(fIdx, sKey, 'url', '');
                  updateServer(fIdx, sKey, 'command', undefined);
                  updateServer(fIdx, sKey, 'args', undefined);
                  updateServer(fIdx, sKey, 'cwd', undefined);
                }
              }}>
              <option value="stdio">标准输入输出 (stdio)</option>
              <option value="http">HTTP</option>
            </select>
          </div>
          {isStdio ? (
            <>
              <div className="pi-field-row">
                <label>命令</label>
                <input className="pi-input" value={server.command || ''} onChange={e => updateServer(fIdx, sKey, 'command', e.target.value)} />
              </div>
              <div className="pi-field-row">
                <label>参数</label>
                <div className="pi-tag-list">
                  {(server.args || []).map((arg, i) => (
                    <span className="pi-tag-item" key={i}>
                      <input className="pi-input pi-tag-input" value={arg} onChange={e => updateServerArg(fIdx, sKey, i, e.target.value)} />
                      <button className="pi-btn-danger-sm" onClick={() => removeServerArg(fIdx, sKey, i)}>×</button>
                    </span>
                  ))}
                  <button className="btn btn-sm" onClick={() => addServerArg(fIdx, sKey)}>＋</button>
                </div>
              </div>
              <div className="pi-field-row">
                <label>工作目录</label>
                <input className="pi-input" value={server.cwd || ''} onChange={e => updateServer(fIdx, sKey, 'cwd', e.target.value)} />
              </div>
            </>
          ) : (
            <div className="pi-field-row">
              <label>URL</label>
              <input className="pi-input" value={server.url || ''} onChange={e => updateServer(fIdx, sKey, 'url', e.target.value)} />
            </div>
          )}
          {/* 环境变量 */}
          <div className="pi-section">
            <div className="pi-section-title">环境变量 ({Object.keys(server.env || {}).length})</div>
            {server.env && Object.keys(server.env).length > 0 && (
              <div className="pi-kv-list">
                {Object.entries(server.env).map(([k, v]) => (
                  <div className="pi-kv-row" key={k}>
                    <input className="pi-input" value={k} onChange={e => updateEnv(fIdx, sKey, k, e.target.value, v)} placeholder="KEY" />
                    <input className="pi-input" value={v} onChange={e => updateEnv(fIdx, sKey, k, k, e.target.value)} placeholder="VALUE" />
                    <button className="pi-btn-danger-sm" onClick={() => removeEnv(fIdx, sKey, k)}>删除</button>
                  </div>
                ))}
              </div>
            )}
            <button className="btn btn-sm" onClick={() => addEnv(fIdx, sKey)}>＋ 添加环境变量</button>
          </div>
        </div>
      </div>
    );
  };

  // 未安装时显示安装提示
  if (installed === false) {
    return (
      <div className="pi-mcp-manager">
        <div className="pi-mcp-toolbar">
          <span className="pi-settings-badge">{status}</span>
          <button className="btn btn-sm" onClick={load}>↻ 刷新</button>
        </div>
        <div className="pi-mcp-install-card">
          <h3>需要安装 pi-mcp-adapter 扩展</h3>
          <p>MCP (Model Context Protocol) 适配器扩展，提供 MCP 服务器管理能力。</p>
          <p className="pi-mcp-install-tip">请在终端运行: <code>pi install npm:pi-mcp-adapter</code></p>
          <p className="pi-mcp-install-tip">安装完成后重启页面即可使用 MCP 管理功能</p>
        </div>
      </div>
    );
  }

  return (
    <div className="pi-mcp-manager">
      <div className="pi-mcp-toolbar">
        <span className="pi-settings-badge">{status}{mcpVersion ? ` v${mcpVersion}` : ''}</span>
        <button className="btn btn-sm" onClick={load}>↻ 刷新</button>
      </div>

      <div className="pi-mcp-files">
        {files.map((file, fIdx) => {
          const key = `file-${fIdx}`;
          const isExpanded = expanded[key] !== false;
          const serverKeys = file.config?.mcpServers ? Object.keys(file.config.mcpServers) : [];
          return (
            <div className="pi-mcp-file-card" key={file.id}>
              <div className="pi-mcp-file-header" onClick={() => toggleFile(fIdx)}>
                <span className="pi-collapse-icon">{isExpanded ? '▼' : '▶'}</span>
                <span className="pi-mcp-file-label">{file.label}</span>
                <span className="pi-mcp-file-badge">{file.exists ? `${serverKeys.length} 个服务器` : '空文件'}</span>
              </div>
              {isExpanded && (
                <div className="pi-mcp-file-body">
                  <code className="pi-mcp-file-path">{file.path}</code>
                  {!file.exists ? (
                    <div className="pi-mcp-file-empty">
                      <p>此配置文件尚不存在</p>
                      <button className="btn btn-sm" onClick={() => addServer(fIdx)}>＋ 创建并添加服务器</button>
                    </div>
                  ) : (
                    <>
                      <div className="pi-mcp-server-list">
                        <div className="pi-mcp-server-list-header">
                          <span>服务器列表</span>
                          <button className="btn btn-sm" onClick={() => addServer(fIdx)}>＋ 添加服务器</button>
                        </div>
                        {serverKeys.map(sKey => renderServerCard(fIdx, sKey, file.config!.mcpServers![sKey]))}
                      </div>
                      <div className="pi-mcp-file-actions">
                        <button className="btn btn-primary btn-sm" disabled={saving[fIdx]} onClick={() => saveFile(fIdx)}>
                          {saving[fIdx] ? '保存中...' : '保存此文件'}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}