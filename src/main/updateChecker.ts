/**
 * GitHub Release 版本检查与下载模块
 *
 * 从 GitHub API 获取最新 release 版本，与当前应用版本比较，
 * 缓存结果避免重复请求。支持下载匹配平台（Windows）的安装包。
 * 所有网络错误/解析失败均优雅降级。
 */

import { version as appVersion } from '../../package.json';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================================
// 常量
// ============================================================================

/** GitHub 仓库 owner/name */
const REPO = 'lazyst/pi-desktop';

/** GitHub API 最新 release 端点 */
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

/** 请求超时（毫秒） */
const FETCH_TIMEOUT_MS = 10_000;

/** 缓存有效期（毫秒），5 分钟内不重复请求 */
const CACHE_TTL_MS = 5 * 60 * 1000;

// ============================================================================
// 类型定义
// ============================================================================

export interface UpdateInfo {
  /** 当前版本号（package.json） */
  currentVersion: string;
  /** 最新 release 版本号（tag，如 v0.3.0），检查失败时为 null */
  latestVersion: string | null;
  /** 是否有可用更新 */
  hasUpdate: boolean;
  /** 最新 release 的 GitHub 页面 URL */
  releaseUrl: string | null;
  /** 最新 release 的标题 */
  releaseName: string | null;
  /** 最新 release 的正文（截取前 500 字符） */
  releaseBody: string | null;
  /** 检查时间（ISO 字符串） */
  checkedAt: string | null;
  /** 错误信息（检查失败时） */
  error: string | null;
  /** 可下载的安装包资产列表 */
  assets: ReleaseAsset[];
}

/** GitHub release 资产（安装包等） */
export interface ReleaseAsset {
  /** 文件名，如 pi-desktop Setup 0.3.0.exe */
  name: string;
  /** 下载 URL */
  url: string;
  /** 文件大小（字节） */
  size: number;
}

/** 下载进度信息 */
export interface DownloadProgress {
  /** 状态 */
  status: 'downloading' | 'completed' | 'error' | 'cancelled';
  /** 下载进度百分比 0-100 */
  percent: number;
  /** 已下载字节数 */
  downloadedBytes: number;
  /** 总字节数 */
  totalBytes: number;
  /** 下载完成后的本地文件路径（status === 'completed' 时有效） */
  filePath?: string;
  /** 错误信息（status === 'error' 时有效） */
  error?: string;
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 简单的 semver 比较（只比较 major.minor.patch）。
 * 返回 1 表示 a > b，-1 表示 a < b，0 表示相等。
 * 忽略前缀 v，非数字段视为 0。
 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split('.')
      .map((s) => {
        const n = parseInt(s, 10);
        return Number.isFinite(n) ? n : 0;
      });

  const partsA = parse(a);
  const partsB = parse(b);
  const len = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < len; i++) {
    const na = partsA[i] ?? 0;
    const nb = partsB[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * 根据当前平台筛选可用的安装包资产。
 * Windows 上匹配 .exe 文件（排除 .blockmap）。
 */
function filterAssets(assets: ReleaseAsset[]): ReleaseAsset[] {
  if (process.platform === 'win32') {
    return assets.filter(
      (a) => a.name.endsWith('.exe') && !a.name.endsWith('.exe.blockmap'),
    );
  }
  if (process.platform === 'darwin') {
    // macOS: 优先 .dmg，其次 .zip
    const dmg = assets.filter((a) => a.name.endsWith('.dmg'));
    if (dmg.length > 0) return dmg;
    return assets.filter((a) => a.name.endsWith('.zip') && !a.name.endsWith('.zip.blockmap'));
  }
  // Linux: .AppImage
  return assets.filter(
    (a) => a.name.endsWith('.AppImage') && !a.name.endsWith('.AppImage.blockmap'),
  );
}

// ============================================================================
// 缓存
// ============================================================================

let cachedResult: UpdateInfo | null = null;
let cachedAt = 0;

// 当前下载状态（用于取消）
let currentDownloadAbort: AbortController | null = null;

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 获取当前版本号（package.json 中的 version 字段）。
 */
export function getCurrentVersion(): string {
  return appVersion;
}

/**
 * 从 GitHub API 检查最新 release 版本。
 * 缓存有效期内返回缓存结果，不发起网络请求。
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  // 缓存有效 → 直接返回
  const now = Date.now();
  if (cachedResult && now - cachedAt < CACHE_TTL_MS) {
    return cachedResult;
  }

  // 构建默认失败结果
  const failed = (error: string): UpdateInfo => ({
    currentVersion: appVersion,
    latestVersion: null,
    hasUpdate: false,
    releaseUrl: null,
    releaseName: null,
    releaseBody: null,
    checkedAt: new Date().toISOString(),
    error,
    assets: [],
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(API_URL, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        // 设置 User-Agent 是 GitHub API 的要求
        'User-Agent': 'pi-desktop',
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const error = `GitHub API 返回 ${response.status} ${response.statusText}`;
      cachedResult = failed(error);
      cachedAt = now;
      return cachedResult;
    }

    const data = (await response.json()) as {
      tag_name?: string;
      html_url?: string;
      name?: string;
      body?: string;
      assets?: Array<{
        name: string;
        browser_download_url: string;
        size: number;
      }>;
    };

    const latestVersion = data.tag_name ?? null;
    const releaseUrl = data.html_url ?? null;
    const releaseName = data.name ?? null;
    const releaseBody = data.body ? data.body.slice(0, 500) : null;

    // 解析资产列表
    const rawAssets: ReleaseAsset[] = (data.assets ?? []).map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
    }));

    const hasUpdate = latestVersion
      ? compareVersions(latestVersion, appVersion) > 0
      : false;

    cachedResult = {
      currentVersion: appVersion,
      latestVersion,
      hasUpdate,
      releaseUrl,
      releaseName,
      releaseBody,
      checkedAt: new Date().toISOString(),
      error: null,
      assets: rawAssets,
    };
    cachedAt = now;
    return cachedResult;
  } catch (err) {
    const error =
      err instanceof Error
        ? err.name === 'AbortError'
          ? '请求超时，请检查网络连接'
          : err.message
        : '未知错误';
    cachedResult = failed(error);
    cachedAt = now;
    return cachedResult;
  }
}

/**
 * 获取缓存的检查结果（不发起网络请求）。
 * 如果从未检查过，返回 null。
 */
export function getUpdateStatus(): UpdateInfo | null {
  return cachedResult;
}

/**
 * 下载最新 release 的安装包。
 *
 * @param onProgress 进度回调，在下载过程中多次调用
 * @returns 下载完成后的本地文件路径
 * @throws 如果下载失败或取消
 */
export async function downloadUpdate(
  onProgress: (progress: DownloadProgress) => void,
): Promise<string> {
  // 1. 获取 release 信息（优先缓存）
  const info = cachedResult ?? (await checkForUpdate());
  if (!info.latestVersion) {
    throw new Error('暂无版本信息，请先检查更新');
  }

  // 2. 筛选当前平台的安装包
  const matched = filterAssets(info.assets);
  if (matched.length === 0) {
    throw new Error(
      `未找到适用于 ${process.platform} 平台的安装包`,
    );
  }

  // 取第一个匹配项（通常只有一个）
  const asset = matched[0];

  // 3. 准备下载
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-desktop-update-'));
  const localPath = path.join(tempDir, asset.name);

  const abortController = new AbortController();
  currentDownloadAbort = abortController;

  try {
    const response = await fetch(asset.url, {
      headers: {
        Accept:
          'application/octet-stream, application/vnd.github.v3.raw;q=0.9',
        'User-Agent': 'pi-desktop',
      },
      signal: abortController.signal,
      // 不跟随重定向，手动处理以获取 Content-Disposition 等响应头
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(
        `下载失败，服务器返回 ${response.status} ${response.statusText}`,
      );
    }

    const totalBytes =
      Number(response.headers.get('content-length')) || asset.size || 0;
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('无法读取响应数据流');
    }

    const writeStream = fs.createWriteStream(localPath);
    let downloadedBytes = 0;

    // 逐块读取并写入文件
    const pump = async () => {
      while (true) {
        const { done, value } = await reader!.read();
        if (done) break;

        writeStream.write(Buffer.from(value));
        downloadedBytes += value.length;

        const percent = totalBytes > 0
          ? Math.round((downloadedBytes / totalBytes) * 100)
          : 0;

        onProgress({
          status: 'downloading',
          percent: Math.min(percent, 99),
          downloadedBytes,
          totalBytes,
        });
      }
    };

    await pump();
    writeStream.end();

    // 等待写入完成
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    // 下载完成
    onProgress({
      status: 'completed',
      percent: 100,
      downloadedBytes,
      totalBytes,
      filePath: localPath,
    });

    currentDownloadAbort = null;
    return localPath;
  } catch (err) {
    currentDownloadAbort = null;
    // 清理临时文件
    try {
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
      if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    } catch { /* 忽略清理错误 */ }

    const error =
      err instanceof Error
        ? err.name === 'AbortError'
          ? '下载已取消'
          : err.message
        : '下载失败';

    onProgress({
      status: 'error',
      percent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      error,
    });
    throw new Error(error);
  }
}

/**
 * 取消当前正在进行的下载。
 */
export function cancelDownload(): void {
  if (currentDownloadAbort) {
    currentDownloadAbort.abort();
    currentDownloadAbort = null;
  }
}

/**
 * 运行已下载的安装包。
 * 在 Windows 上启动 installer，然后退出应用以便安装程序覆盖文件。
 */
export function installUpdate(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`安装包不存在: ${filePath}`);
  }

  const { execFile } = require('node:child_process');

  if (process.platform === 'win32') {
    // Windows: 静默启动安装包，后续安装程序会接管
    execFile(filePath, [], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else if (process.platform === 'darwin') {
    // macOS: 挂载 dmg 或打开 zip
    if (filePath.endsWith('.dmg')) {
      execFile('open', [filePath], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } else {
      execFile('open', [filePath], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    }
  } else {
    // Linux: 执行 AppImage
    fs.chmodSync(filePath, 0o755);
    execFile(filePath, [], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  }
}