import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

/**
 * Pi 工具配置相关 IPC handler 注册。
 *
 * 管理 settings、models、MCP、skills、extensions 的读写。
 */
export function registerPiToolHandlers(
  ipcMain: Electron.IpcMain,
  win: Electron.BrowserWindow,
  piAgentDir: string,
): void {
  /** 深度合并 source 到 target（仅对象，数组直接替换） */
  function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = { ...target };
    for (const key of Object.keys(source)) {
      const sv = source[key];
      const tv = result[key];
      if (sv !== null && typeof sv === 'object' && !Array.isArray(sv) &&
          tv !== null && typeof tv === 'object' && !Array.isArray(tv)) {
        result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
      } else {
        result[key] = sv;
      }
    }
    return result;
  }

  // ── Settings ──
  ipcMain.handle('pi:settings:get', (_e, scope: 'global' | 'project') => {
    const settingsPath = scope === 'project'
      ? path.join(process.cwd(), '.pi', 'settings.json')
      : path.join(piAgentDir, 'settings.json');
    const exists = fs.existsSync(settingsPath);
    let data: unknown = null;
    let raw = '';
    if (exists) {
      raw = fs.readFileSync(settingsPath, 'utf-8');
      try { data = JSON.parse(raw); } catch { /* 不合法 JSON 也能编辑 */ }
    }
    return { data, raw, path: settingsPath, exists };
  });

  ipcMain.handle('pi:settings:set', (_e, payload: { scope: 'global' | 'project'; data?: Record<string, unknown>; raw?: string }) => {
    const settingsPath = payload.scope === 'project'
      ? path.join(process.cwd(), '.pi', 'settings.json')
      : path.join(piAgentDir, 'settings.json');
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (payload.raw !== undefined) {
      fs.writeFileSync(settingsPath, payload.raw, 'utf-8');
    } else if (payload.data !== undefined) {
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(settingsPath)) {
        try { existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { /* 忽略损坏的现有文件 */ }
      }
      const merged = deepMerge(existing, payload.data);
      fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    }
    return { success: true, path: settingsPath };
  });

  // ── Models ──
  const modelsPath = path.join(piAgentDir, 'models.json');

  ipcMain.handle('pi:models:get', () => {
    if (fs.existsSync(modelsPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
        return data;
      } catch { /* fall through */ }
    }
    return { providers: {} };
  });

  ipcMain.handle('pi:models:set', (_e, data: unknown) => {
    if (!fs.existsSync(piAgentDir)) fs.mkdirSync(piAgentDir, { recursive: true });
    fs.writeFileSync(modelsPath, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true };
  });

  // ── MCP ──
  ipcMain.handle('pi:mcp:configs', () => {
    const cwd = process.cwd();
    const home = os.homedir();
    const files = [
      { id: 'user-global', label: '用户全局配置 (Shared)', path: path.join(home, '.config', 'mcp', 'mcp.json') },
      { id: 'pi-global', label: 'Pi 全局覆盖 (Pi Agent)', path: path.join(piAgentDir, 'mcp.json') },
      { id: 'project-shared', label: '项目共享 (Project)', path: path.join(cwd, '.mcp.json') },
      { id: 'project-pi', label: 'Pi 项目覆盖 (Project Pi)', path: path.join(cwd, '.pi', 'mcp.json') },
    ];
    return files.map(f => {
      const exists = fs.existsSync(f.path);
      let config: unknown = null;
      if (exists) {
        try { config = JSON.parse(fs.readFileSync(f.path, 'utf-8')); } catch { /* empty */ }
      }
      return { ...f, exists, config };
    });
  });

  ipcMain.handle('pi:mcp:configs:save', (_e, payload: { id: string; config: unknown }) => {
    const home = os.homedir();
    const cwd = process.cwd();
    const fileDefs: Record<string, string> = {
      'user-global': path.join(home, '.config', 'mcp', 'mcp.json'),
      'pi-global': path.join(piAgentDir, 'mcp.json'),
      'project-shared': path.join(cwd, '.mcp.json'),
      'project-pi': path.join(cwd, '.pi', 'mcp.json'),
    };
    const filePath = fileDefs[payload.id];
    if (!filePath) throw new Error('Unknown MCP config: ' + payload.id);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload.config, null, 2), 'utf-8');
    return { success: true, path: filePath };
  });

  ipcMain.handle('pi:mcp:status', () => {
    const locations = [
      path.join(piAgentDir, 'npm', 'node_modules', 'pi-mcp-adapter', 'package.json'),
      path.join(piAgentDir, 'node_modules', 'pi-mcp-adapter', 'package.json'),
    ];
    for (const loc of locations) {
      if (fs.existsSync(loc)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(loc, 'utf-8'));
          return { installed: true, version: pkg.version };
        } catch { /* ignore */ }
      }
    }
    return { installed: false };
  });

  // ── Skills ──
  const SKILL_ROOTS = [
    path.join(piAgentDir, 'skills'),
    path.join(os.homedir(), '.agents', 'skills'),
  ];

  function readSkillDescription(skillDir: string): string | undefined {
    const skillMd = path.join(skillDir, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      const content = fs.readFileSync(skillMd, 'utf-8');
      const match = content.match(/description:\s*"([^"]+)"|description:\s*([^\r\n]+)/);
      return match?.[1] || match?.[2]?.trim() || undefined;
    }
    return undefined;
  }

  function findSkillRoot(name: string): { root: string; disabled: boolean } | null {
    for (const root of SKILL_ROOTS) {
      const normal = path.join(root, name);
      if (fs.existsSync(normal) && fs.statSync(normal).isDirectory()) {
        return { root, disabled: false };
      }
      const disabled = path.join(root, '.disabled', name);
      if (fs.existsSync(disabled) && fs.statSync(disabled).isDirectory()) {
        return { root, disabled: true };
      }
    }
    return null;
  }

  interface SkillInfo {
    name: string;
    disabled: boolean;
    description?: string;
    source: string | null;
    sourceUrl: string | null;
    sourceType: string | null;
  }

  function listSkills(): SkillInfo[] {
    const state = readPiToolState();
    const sourceCache: Record<string, { source: string; sourceUrl: string; sourceType: string }> =
      (state.skillSourceCache as any) || {};

    const result: SkillInfo[] = [];
    const seenNames = new Set<string>();

    for (const root of SKILL_ROOTS) {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const skillDir = path.join(root, entry.name);
          const description = readSkillDescription(skillDir);
          const cached = sourceCache[entry.name];
          result.push({
            name: entry.name,
            disabled: false,
            description,
            source: cached?.source ?? null,
            sourceUrl: cached?.sourceUrl ?? null,
            sourceType: cached?.sourceType ?? null,
          });
          seenNames.add(entry.name);
        }
      }
    }

    for (const root of SKILL_ROOTS) {
      const disabledDir = path.join(root, '.disabled');
      if (!fs.existsSync(disabledDir)) continue;
      for (const entry of fs.readdirSync(disabledDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !seenNames.has(entry.name)) {
          const skillDir = path.join(disabledDir, entry.name);
          const description = readSkillDescription(skillDir);
          const cached = sourceCache[entry.name];
          result.push({
            name: entry.name,
            disabled: true,
            description,
            source: cached?.source ?? null,
            sourceUrl: cached?.sourceUrl ?? null,
            sourceType: cached?.sourceType ?? null,
          });
          seenNames.add(entry.name);
        }
      }
    }
    return result;
  }

  function refreshSkillSourceCache(): void {
    try {
      const output = execSync('npx skills ls -g --json', {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: true,
      });
      const npxResults: any[] = JSON.parse(output);
      const cache: Record<string, { source: string; sourceUrl: string; sourceType: string }> = {};
      for (const skill of npxResults) {
        if (skill.source) {
          cache[skill.name] = {
            source: skill.source,
            sourceUrl: skill.sourceUrl || '',
            sourceType: skill.sourceType || '',
          };
        }
      }
      const state = readPiToolState();
      state.skillSourceCache = cache;
      writePiToolState(state);
    } catch {
      // npx skills 不可用时跳过
    }
  }

  ipcMain.handle('pi:skills:list', () => ({ skills: listSkills() }));

  ipcMain.handle('pi:skills:refreshCache', () => {
    refreshSkillSourceCache();
    return { skills: listSkills() };
  });

  ipcMain.handle('pi:skills:disable', (_e, payload: { name: string; source?: string | null }) => {
    const found = findSkillRoot(payload.name);
    if (!found || found.disabled) return { success: false, error: 'Skill not found or already disabled' };
    const src = path.join(found.root, payload.name);
    const dst = path.join(found.root, '.disabled', payload.name);
    const disabledDir = path.join(found.root, '.disabled');
    if (!fs.existsSync(disabledDir)) fs.mkdirSync(disabledDir, { recursive: true });
    fs.renameSync(src, dst);
    if (payload.source) {
      try {
        const state = readPiToolState();
        if (!state.disabledSkills) state.disabledSkills = {};
        (state.disabledSkills as Record<string, string>)[payload.name] = payload.source;
        writePiToolState(state);
      } catch { /* ignore */ }
    }
    return { success: true };
  });

  ipcMain.handle('pi:skills:enable', (_e, name: string) => {
    const found = findSkillRoot(name);
    if (!found || !found.disabled) return { success: false, error: 'Disabled skill not found' };
    const src = path.join(found.root, '.disabled', name);
    const dst = path.join(found.root, name);
    fs.renameSync(src, dst);
    try {
      const state = readPiToolState();
      if (state.disabledSkills && typeof state.disabledSkills === 'object') {
        delete (state.disabledSkills as Record<string, string>)[name];
        writePiToolState(state);
      }
    } catch { /* ignore */ }
    return { success: true };
  });

  ipcMain.handle('pi:skills:delete', async (_e, payload: { name: string; disabled?: boolean }) => {
    if (!payload.disabled) {
      try {
        execSync(`npx skills remove "${payload.name}" -g -y`, {
          timeout: 15000,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: true,
        });
      } catch {
        // npx skills remove 失败，fallback 到文件系统
      }
    }

    let deleted = false;
    for (const root of SKILL_ROOTS) {
      const normal = path.join(root, payload.name);
      if (fs.existsSync(normal)) {
        fs.rmSync(normal, { recursive: true, force: true });
        deleted = true;
      }
      const disabled = path.join(root, '.disabled', payload.name);
      if (fs.existsSync(disabled)) {
        fs.rmSync(disabled, { recursive: true, force: true });
        deleted = true;
      }
    }

    try {
      const state = readPiToolState();
      if (state.disabledSkills && typeof state.disabledSkills === 'object') {
        delete (state.disabledSkills as Record<string, string>)[payload.name];
        writePiToolState(state);
      }
    } catch { /* ignore */ }

    return { success: deleted, error: deleted ? undefined : 'Skill not found' };
  });

  ipcMain.handle('pi:skills:batchDisable', (_e, payload: { names: string[]; source?: string | null }) => {
    const results: Array<{ name: string; success: boolean; error?: string }> = [];
    for (const name of payload.names) {
      const found = findSkillRoot(name);
      if (!found || found.disabled) {
        results.push({ name, success: false, error: 'Skill not found or already disabled' });
        continue;
      }
      const src = path.join(found.root, name);
      const dst = path.join(found.root, '.disabled', name);
      const disabledDir = path.join(found.root, '.disabled');
      try {
        if (!fs.existsSync(disabledDir)) fs.mkdirSync(disabledDir, { recursive: true });
        fs.renameSync(src, dst);
        results.push({ name, success: true });
      } catch (err) {
        results.push({ name, success: false, error: String(err) });
      }
    }
    if (payload.source) {
      try {
        const state = readPiToolState();
        if (!state.disabledSkills) state.disabledSkills = {};
        for (const r of results) {
          if (r.success) {
            (state.disabledSkills as Record<string, string>)[r.name] = payload.source;
          }
        }
        writePiToolState(state);
      } catch { /* ignore */ }
    }
    return { results };
  });

  ipcMain.handle('pi:skills:batchDelete', async (_e, payload: { names: string[] }) => {
    const results: Array<{ name: string; success: boolean; error?: string }> = [];
    for (const name of payload.names) {
      try {
        try {
          execSync(`npx skills remove "${name}" -g -y`, {
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            shell: true,
          });
        } catch { /* fallback */ }

        let deleted = false;
        for (const root of SKILL_ROOTS) {
          const normal = path.join(root, name);
          if (fs.existsSync(normal)) {
            fs.rmSync(normal, { recursive: true, force: true });
            deleted = true;
          }
          const disabled = path.join(root, '.disabled', name);
          if (fs.existsSync(disabled)) {
            fs.rmSync(disabled, { recursive: true, force: true });
            deleted = true;
          }
        }
        results.push({ name, success: deleted });
      } catch (err) {
        results.push({ name, success: false, error: String(err) });
      }
    }
    try {
      const state = readPiToolState();
      if (state.disabledSkills && typeof state.disabledSkills === 'object') {
        for (const r of results) {
          if (r.success) {
            delete (state.disabledSkills as Record<string, string>)[r.name];
          }
        }
        writePiToolState(state);
      }
    } catch { /* ignore */ }
    return { results };
  });

  // ── Extensions ──
  const extDir = path.join(piAgentDir, 'extensions');
  const disabledExtDir = path.join(piAgentDir, 'extensions', '.disabled');

  function getPackageSourceString(pkg: unknown): string {
    if (typeof pkg === 'string') return pkg;
    if (pkg && typeof pkg === 'object') {
      const s = (pkg as Record<string, unknown>).source;
      return typeof s === 'string' ? s : '';
    }
    return '';
  }

  function getPackageDisplayName(source: string): string {
    if (source.startsWith('npm:')) return source.slice(4);
    if (source.startsWith('git:')) {
      const parts = source.split('/');
      return parts[parts.length - 1] || source;
    }
    return path.basename(source.replace(/\\/g, '/'));
  }

  function readSettingsPackages(settingPath: string): { packages: unknown[]; extensions: string[] } {
    if (!fs.existsSync(settingPath)) return { packages: [], extensions: [] };
    try {
      const data = JSON.parse(fs.readFileSync(settingPath, 'utf-8'));
      return {
        packages: Array.isArray(data.packages) ? data.packages : [],
        extensions: Array.isArray(data.extensions) ? data.extensions : [],
      };
    } catch {
      return { packages: [], extensions: [] };
    }
  }

  ipcMain.handle('pi:extensions:list', () => {
    const result: Array<{ name: string; type: string; source: string; disabled: boolean; managed: boolean; dir?: string }> = [];

    if (fs.existsSync(extDir)) {
      for (const entry of fs.readdirSync(extDir, { withFileTypes: true })) {
        if (!entry.name.startsWith('.') && (entry.isDirectory() || entry.isFile())) {
          result.push({ name: entry.name, type: 'local', source: path.join(extDir, entry.name), disabled: false, managed: true, dir: path.join(extDir, entry.name) });
        }
      }
    }
    if (fs.existsSync(disabledExtDir)) {
      for (const entry of fs.readdirSync(disabledExtDir, { withFileTypes: true })) {
        if (!entry.name.startsWith('.') && (entry.isDirectory() || entry.isFile())) {
          result.push({ name: entry.name, type: 'local', source: path.join(disabledExtDir, entry.name), disabled: true, managed: true, dir: path.join(disabledExtDir, entry.name) });
        }
      }
    }

    const globalSettingsPath = path.join(piAgentDir, 'settings.json');
    const projectSettingsPath = path.join(process.cwd(), '.pi', 'settings.json');
    const globalPkgs = readSettingsPackages(globalSettingsPath);
    const projectPkgs = readSettingsPackages(projectSettingsPath);
    const state = readPiToolState();
    const disabledPackages: string[] = (state.disabledExtensions as string[]) || [];

    const seenPkgSources = new Set<string>();
    for (const pkg of [...globalPkgs.packages, ...projectPkgs.packages]) {
      const source = getPackageSourceString(pkg);
      if (!source || seenPkgSources.has(source)) continue;
      seenPkgSources.add(source);
      result.push({ name: getPackageDisplayName(source), type: 'package', source, disabled: disabledPackages.includes(source), managed: true });
    }
    for (const source of disabledPackages) {
      if (seenPkgSources.has(source)) continue;
      seenPkgSources.add(source);
      result.push({ name: getPackageDisplayName(source), type: 'package', source, disabled: true, managed: true });
    }

    return { extensions: result };
  });

  ipcMain.handle('pi:extensions:disable', (_e, payload: { name: string; type: string; source: string; dir?: string }) => {
    if (payload.type === 'local' && payload.dir) {
      const src = payload.dir;
      const dst = path.join(disabledExtDir, payload.name);
      if (!fs.existsSync(src)) return { success: false, error: 'Extension not found' };
      if (!fs.existsSync(disabledExtDir)) fs.mkdirSync(disabledExtDir, { recursive: true });
      fs.renameSync(src, dst);
      return { success: true };
    }
    if (payload.type === 'package') {
      const settingsPaths = [path.join(piAgentDir, 'settings.json'), path.join(process.cwd(), '.pi', 'settings.json')];
      let changed = false;
      for (const sp of settingsPaths) {
        if (fs.existsSync(sp)) {
          try {
            const settings = JSON.parse(fs.readFileSync(sp, 'utf-8'));
            if (Array.isArray(settings.packages)) {
              const before = settings.packages.length;
              settings.packages = settings.packages.filter((p: unknown) => getPackageSourceString(p) !== payload.source);
              if (settings.packages.length !== before) {
                changed = true;
                fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
              }
            }
          } catch { /* empty */ }
        }
      }
      if (changed) {
        const st = readPiToolState();
        const list: string[] = (st.disabledExtensions as string[]) || [];
        if (!list.includes(payload.source)) {
          list.push(payload.source);
          st.disabledExtensions = list;
          writePiToolState(st);
        }
      }
      return { success: changed };
    }
    return { success: false, error: 'Unsupported extension type' };
  });

  ipcMain.handle('pi:extensions:enable', (_e, payload: { name: string; type: string; source: string; dir?: string }) => {
    if (payload.type === 'local' && payload.dir) {
      const src = payload.dir;
      const dst = path.join(extDir, payload.name);
      if (!fs.existsSync(src)) return { success: false, error: 'Extension not found' };
      if (!fs.existsSync(extDir)) fs.mkdirSync(extDir, { recursive: true });
      fs.renameSync(src, dst);
      return { success: true };
    }
    if (payload.type === 'package') {
      const st = readPiToolState();
      const list: string[] = (st.disabledExtensions as string[]) || [];
      const idx = list.indexOf(payload.source);
      if (idx === -1) return { success: false, error: 'Extension not found in disabled list' };
      list.splice(idx, 1);
      st.disabledExtensions = list;
      writePiToolState(st);
      const globalSettingsPath = path.join(piAgentDir, 'settings.json');
      try {
        const settings = fs.existsSync(globalSettingsPath)
          ? JSON.parse(fs.readFileSync(globalSettingsPath, 'utf-8'))
          : {};
        if (!Array.isArray(settings.packages)) settings.packages = [];
        if (!settings.packages.includes(payload.source)) {
          settings.packages.push(payload.source);
          const dir = path.dirname(globalSettingsPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(globalSettingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
        }
        return { success: true };
      } catch {
        return { success: false, error: 'Failed to write settings' };
      }
    }
    return { success: false, error: 'Unsupported extension type' };
  });

  ipcMain.handle('pi:extensions:delete', (_e, payload: { name: string; type: string; source: string; dir?: string }) => {
    if (payload.type === 'local' && payload.dir) {
      if (!fs.existsSync(payload.dir)) return { success: false, error: 'Extension not found' };
      fs.rmSync(payload.dir, { recursive: true, force: true });
      return { success: true };
    }
    if (payload.type === 'package') {
      const settingsPaths = [path.join(piAgentDir, 'settings.json'), path.join(process.cwd(), '.pi', 'settings.json')];
      let changed = false;
      for (const sp of settingsPaths) {
        if (fs.existsSync(sp)) {
          try {
            const settings = JSON.parse(fs.readFileSync(sp, 'utf-8'));
            if (Array.isArray(settings.packages)) {
              const before = settings.packages.length;
              settings.packages = settings.packages.filter((p: unknown) => getPackageSourceString(p) !== payload.source);
              if (settings.packages.length !== before) {
                changed = true;
                fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
              }
            }
          } catch { /* empty */ }
        }
      }
      if (changed) {
        const st = readPiToolState();
        const list: string[] = (st.disabledExtensions as string[]) || [];
        const idx = list.indexOf(payload.source);
        if (idx !== -1) {
          list.splice(idx, 1);
          st.disabledExtensions = list;
          writePiToolState(st);
        }
      }
      return { success: changed };
    }
    return { success: false, error: 'Unsupported extension type' };
  });
}

/** 读取 Pi 工具状态缓存文件。 */
function readPiToolState(): Record<string, unknown> {
  const piAgentDir = path.join(os.homedir(), '.pi', 'agent');
  const statePath = path.join(piAgentDir, 'pi-tool-state.json');
  if (fs.existsSync(statePath)) {
    try { return JSON.parse(fs.readFileSync(statePath, 'utf-8')); } catch { /* empty */ }
  }
  return {};
}

/** 写入 Pi 工具状态缓存文件。 */
function writePiToolState(state: Record<string, unknown>): void {
  const piAgentDir = path.join(os.homedir(), '.pi', 'agent');
  fs.writeFileSync(path.join(piAgentDir, 'pi-tool-state.json'), JSON.stringify(state, null, 2), 'utf-8');
}