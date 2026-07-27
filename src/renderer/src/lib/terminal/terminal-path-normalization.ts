/** 路径归一化工具 —— 绝对路径、Windows 盘符、UNC、tilde 路径展开。
 *
 * 本模块将终端产生的路径字符串（可能混用 / 和 \、包含 . 和 .. 片段、
 * 以 ~ 开头等）归一化为一致的前向斜杠形式，便于比较和拼接。
 *
 * 与 Node.js path 模块不同，本模块不依赖文件系统，所有操作都是纯字符串变换。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type NormalizedAbsolutePath = {
  normalized: string
  comparisonKey: string
  rootKind: 'posix' | 'windows' | 'unc'
}

// ---------------------------------------------------------------------------
// 内部 helpers
// ---------------------------------------------------------------------------

/** 将路径字符串按 / 或 \ 分割，解析 . 和 .. 片段，返回规范化后的片段列表。 */
function normalizeSegments(pathValue: string): string[] {
  const segments = pathValue.split(/[\\/]+/)
  const stack: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (stack.length > 0) {
        stack.pop()
      }
      continue
    }
    stack.push(segment)
  }

  return stack
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/** 将任意绝对路径字符串归一化为统一格式。
 *
 * 支持三种根类型：
 * - `posix`：以 `/` 开头（如 `/home/user`）
 * - `windows`：以盘符开头（如 `C:\Users` → `C:/Users`）
 * - `unc`：以 `\\server\share` 或 `//server/share` 开头
 *
 * 返回 `null` 表示输入不是绝对路径。
 */
export function normalizeAbsolutePath(pathValue: string): NormalizedAbsolutePath | null {
  // 1) Windows 盘符：C:\... 或 C:/...
  const windowsDriveMatch = /^([A-Za-z]):[\\/]*(.*)$/.exec(pathValue)
  if (windowsDriveMatch) {
    const driveLetter = windowsDriveMatch[1].toUpperCase()
    const suffix = normalizeSegments(windowsDriveMatch[2]).join('/')
    const normalized = suffix ? `${driveLetter}:/${suffix}` : `${driveLetter}:/`
    return {
      normalized,
      comparisonKey: normalized.toLowerCase(),
      rootKind: 'windows'
    }
  }

  // 2) UNC 路径：\\server\share\... 或 //server/share/...
  const uncMatch = /^(?:\\\\|\/\/)([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]*(.*))?$/.exec(pathValue)
  if (uncMatch) {
    const server = uncMatch[1]
    const share = uncMatch[2]
    const suffix = normalizeSegments(uncMatch[3] ?? '').join('/')
    const normalizedRoot = `//${server}/${share}`
    const normalized = suffix ? `${normalizedRoot}/${suffix}` : normalizedRoot
    return {
      normalized,
      comparisonKey: normalized.toLowerCase(),
      rootKind: 'unc'
    }
  }

  // 3) POSIX 绝对路径：/...
  if (pathValue.startsWith('/')) {
    const normalized = `/${normalizeSegments(pathValue).join('/')}`.replace(/\/+$/, '') || '/'
    return {
      normalized,
      comparisonKey: normalized,
      rootKind: 'posix'
    }
  }

  return null
}

/** 从 cwd 推断用户的 home 目录路径。
 *
 * 适用于远程 / devcontainer 等无法通过环境变量获取 HOME 的场景。
 * 支持：
 * - Windows：`C:/Users/<username>`
 * - POSIX：`/Users/<username>`、`/home/<username>`、`/root`
 */
export function inferHomePathFromCwd(cwd: string): string | null {
  const normalizedCwd = normalizeAbsolutePath(cwd)
  if (!normalizedCwd) {
    return null
  }

  const segments = normalizeSegments(normalizedCwd.normalized)
  if (normalizedCwd.rootKind === 'windows') {
    const [drive, usersSegment, userSegment] = segments
    if (!drive || !usersSegment || !userSegment || usersSegment.toLowerCase() !== 'users') {
      return null
    }
    return `${drive}/${usersSegment}/${userSegment}`
  }

  if (normalizedCwd.rootKind === 'posix') {
    const [rootParent, userSegment] = segments
    if ((rootParent === 'Users' || rootParent === 'home') && userSegment) {
      return `/${rootParent}/${userSegment}`
    }
    if (rootParent === 'root') {
      return '/root'
    }
  }

  return null
}

/** 将显式传入的 home 路径规范化，空值或空白字符串返回 null。 */
function normalizeExplicitHomePath(homePath: string | null | undefined): string | null {
  const trimmedHomePath = homePath?.trim()
  if (!trimmedHomePath) {
    return null
  }

  return normalizeAbsolutePath(trimmedHomePath)?.normalized ?? null
}

/** 将 `~` 开头的路径展开为绝对路径。
 *
 * 优先使用显式传入的 `homePath`（如终端自身的 `~` 解析结果），
 * 回退到从 `cwd` 推断 home 目录。
 * 返回 `null` 表示路径不以 `~` 开头或无法确定 home 目录。
 */
export function resolveTildePath(
  pathValue: string,
  cwd: string,
  homePath?: string | null
): string | null {
  if (!/^~[\\/]/.test(pathValue)) {
    return null
  }

  // 为什么：远程 / devcontainer 终端的 cwd 可能在用户 home 之外；
  // 当调用方有显式 home 路径时优先使用它。
  const resolvedHomePath = normalizeExplicitHomePath(homePath) ?? inferHomePathFromCwd(cwd)
  if (!resolvedHomePath) {
    return null
  }

  return joinAbsolutePath(resolvedHomePath, pathValue.slice(2))
}

/** 将绝对路径 basePath 与相对路径 relativePath 拼接，返回归一化后的绝对路径。
 *
 * 如果 basePath 不是绝对路径，返回 null。
 */
export function joinAbsolutePath(basePath: string, relativePath: string): string | null {
  const normalizedBase = normalizeAbsolutePath(basePath)
  if (!normalizedBase) {
    return null
  }

  return normalizeJoinedPath(normalizedBase, relativePath)
}

/** 将规范化后的 basePath 与相对路径拼接，生成最终归一化路径字符串。
 *
 * 与分别对 base 和 relative 做 normalizeSegments 再拼接不同，
 * 这里先将两者合并为一个字符串再归一化，使得 relative 中的 `..`
 * 可以正确回退到 base 的片段上。
 */
function normalizeJoinedPath(basePath: NormalizedAbsolutePath, relativePath: string): string {
  const combined = `${basePath.normalized}/${relativePath}`
  const joinedSegments = normalizeSegments(combined)

  if (basePath.rootKind === 'unc') {
    const [server, share, ...rest] = joinedSegments
    return rest.length > 0 ? `//${server}/${share}/${rest.join('/')}` : `//${server}/${share}`
  }

  if (basePath.rootKind === 'windows') {
    const [drive, ...rest] = joinedSegments
    return rest.length > 0 ? `${drive}/${rest.join('/')}` : drive
  }

  return `/${joinedSegments.join('/')}`.replace(/\/+$/, '') || '/'
}