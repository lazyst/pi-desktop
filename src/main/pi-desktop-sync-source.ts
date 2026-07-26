/**
 * Pi Desktop 同步扩展源码 —— 由 ensurePiDesktopExtension() 写入 ~/.pi/agent/extensions/。
 *
 * 此文件在 pi 进程内运行（由 jiti 加载），不能引用 pi-desktop 或 Electron 的任何模块。
 * 仅依赖 @earendil-works/pi-coding-agent 的 ExtensionAPI 类型。
 *
 * 环境变量守卫：
 * - 仅在 PI_DESKTOP=1 时生效（即由 pi-desktop spawn 的 pi 进程）
 * - 独立终端中运行的 pi 不受影响
 */
export const PI_DESKTOP_SYNC_FILE = 'pi-desktop-sync.ts'

export function getPiDesktopSyncExtensionSource(): string {
  return [
    '// @pi-desktop-managed',
    'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
    'import { randomUUID } from "node:crypto";',
    '',
    'export default function (pi: ExtensionAPI) {',
    '  if (!process.env.PI_DESKTOP) return;',
    '  pi.on("session_start", async (event, ctx) => {',
    '    if (event.reason !== "new") return;',
    '    const uuid = randomUUID();',
    '    const cwd = ctx.cwd;',
    '    const name = ctx.sessionManager.getSessionName() ?? "pi";',
    '    process.stdout.write(',
    '      `\\x1b]633;PiNew;${escapeField(uuid)};${escapeField(cwd)};${escapeField(name)}\\x07`,',
    '    );',
    '  });',
    '}',
    '',
    'function escapeField(s: string): string {',
    '  return s.replace(/\\\\/g, "\\\\\\\\").replace(/;/g, "\\\\;").replace(/\\x07/g, "\\\\a");',
    '}',
    '',
  ].join('\n')
}