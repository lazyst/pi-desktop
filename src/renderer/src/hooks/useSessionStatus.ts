import { useState, useRef, useEffect } from 'react';
import { pi } from '../ipc';
import { useTabStore } from '../store/tabStore';
import type { SessionStatus } from '../types';

/**
 * 模块级映射表：pi-<uuid> → ptyId（live-<uuid>），供 handleOpen 查找。
 * 用模块级变量而非 React state/ref，避免闭包/渲染时序问题。
 * 被多个函数和回调共享，不从 App.tsx 移入 hook。
 */
export const _virtualToPty = new Map<string, string>();

interface DiskSession {
  key: string;
  cwd: string;
  name: string;
  time?: string;
  unsaved?: boolean;
}

function toDisk(
  groups: { cwd: string; sessions: Array<{ key: string; name: string; time: string }> }[],
): DiskSession[] {
  return groups.flatMap((g) => g.sessions.map((s) => ({ key: s.key, cwd: g.cwd, name: s.name, time: s.time })));
}

/**
 * 会话状态追踪 hook：管理 statusMap、liveToDisk、ptyOwnersRef、virtualSessions。
 *
 * 负责：
 * - 订阅主进程会话状态推送（onStatus / onExit / onIndex / onRelink / onNewFromPi）
 * - 维护 PTY 所有权映射（ptyOwnersRef）
 * - 维护 live 会话 → 磁盘会话映射（liveToDisk / liveToDiskRef）
 * - 维护虚拟 session 列表（virtualSessions）
 */
export function useSessionStatus() {
  const [statusMap, setStatusMap] = useState<Record<string, SessionStatus>>({});
  const [liveToDisk, setLiveToDisk] = useState<Record<string, string>>({});
  const liveToDiskRef = useRef<Record<string, string>>({});
  const ptyOwnersRef = useRef<Map<string, string>>(new Map());
  const [virtualSessions, setVirtualSessions] = useState<DiskSession[]>([]);

  useEffect(() => {
    const offStatus = pi.onStatus((key, status) => setStatusMap((m) => ({ ...m, [key]: status })));
    const offExit = pi.onExit((key) => {
      setStatusMap((m) => ({ ...m, [key]: 'dead' }));
      useTabStore.getState().removeSessionTab(key);
      const ownerKey = ptyOwnersRef.current.get(key);
      if (ownerKey && ownerKey !== key) {
        setStatusMap((m) => ({ ...m, [ownerKey]: 'dead' }));
        setVirtualSessions((prev) => prev.filter((s) => s.key !== ownerKey));
        _virtualToPty.delete(ownerKey);
      }
      ptyOwnersRef.current = new Map([...ptyOwnersRef.current].filter(([k]) => k !== key));
    });
    const offIndex = pi.onIndex((groups) => {
      const diskList = toDisk(groups);
      const diskKeys = diskList.map((d) => d.key);
      setStatusMap((m) => {
        let changed = false;
        const next = { ...m };
        for (const k of diskKeys) {
          if (next[k] === undefined) { next[k] = 'dead'; changed = true; }
        }
        return changed ? next : m;
      });
      useTabStore.getState().promoteTabNames(diskList);
    });
    const offRelink = pi.onRelink((from, to) => {
      liveToDiskRef.current = { ...liveToDiskRef.current, [from]: to };
      for (const [virtualKey, ptyId] of _virtualToPty) {
        if (ptyId === from) {
          liveToDiskRef.current[virtualKey] = to;
          setVirtualSessions((prev) => prev.filter((s) => s.key !== virtualKey));
          _virtualToPty.delete(virtualKey);
          break;
        }
      }
      setLiveToDisk(liveToDiskRef.current);
    });
    if (pi.onNewFromPi) {
      pi.onNewFromPi(({ ptyId, uuid, cwd, name }) => {
        const newKey = `pi-${uuid}`;
        const currentOwner = ptyOwnersRef.current.get(ptyId);
        if (currentOwner) {
          setStatusMap((m) => ({ ...m, [currentOwner]: 'dead' }));
          const diskKey = liveToDiskRef.current[currentOwner];
          if (diskKey) setStatusMap((m) => ({ ...m, [diskKey]: 'dead' }));
        }
        const entry: DiskSession = { key: newKey, cwd, name, unsaved: true };
        setVirtualSessions((prev) => [...prev.filter((s) => s.key !== currentOwner), entry]);
        setStatusMap((m) => ({ ...m, [newKey]: 'running' }));
        ptyOwnersRef.current = new Map(ptyOwnersRef.current).set(ptyId, newKey);
        _virtualToPty.set(newKey, ptyId);
        useTabStore.getState().renameSessionTab(ptyId, name);
      });
    }
    // 订阅会话名变更（/name 命令触发）
    let offNameChanged: (() => void) | undefined;
    if (typeof pi.onSessionNameChanged === 'function') {
      offNameChanged = pi.onSessionNameChanged(({ ptyId, name }) => {
        // 更新 tabStore 中的会话名（live tab）
        useTabStore.getState().renameSessionTab(ptyId, name);
        // 如果该 live 会话有对应的虚拟 session（pi-<uuid>），也更新
        for (const [virtualKey, mappedPtyId] of _virtualToPty) {
          if (mappedPtyId === ptyId) {
            useTabStore.getState().renameSessionTab(virtualKey, name);
            break;
          }
        }
        // 更新 virtualSessions 中的名称
        setVirtualSessions((prev) =>
          prev.map((s) => (s.key === ptyId || _virtualToPty.get(s.key) === ptyId ? { ...s, name } : s)),
        );
      });
    }
    return () => { offStatus?.(); offExit?.(); offIndex?.(); offRelink?.(); offNameChanged?.(); };
  }, []);

  return {
    statusMap,
    setStatusMap,
    liveToDisk,
    setLiveToDisk,
    liveToDiskRef,
    ptyOwnersRef,
    virtualSessions,
    setVirtualSessions,
  };
}