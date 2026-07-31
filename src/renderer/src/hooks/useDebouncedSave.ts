import { useEffect, useRef, useState, useCallback } from 'react';

export interface UseDebouncedSaveOptions<T> {
  /** 防抖延迟，默认 800ms */
  delay?: number;
  /** 是否深度比较（对象/数组），默认 false 使用引用比较 */
  deepCompare?: boolean;
  /** 保存失败回调 */
  onError?: (err: Error) => void;
}

export interface UseDebouncedSaveResult {
  /** 是否正在保存中 */
  isSaving: boolean;
  /** 是否有待处理的未保存修改 */
  pending: boolean;
  /** 立即执行待处理的保存 */
  flush: () => Promise<void>;
}

/**
 * 防抖自动保存 hook。
 *
 * 监听 `value` 变化，在最后一次变化后的 `delay` 毫秒自动调用 `saveFn`。
 * 组件卸载时自动执行 `flush` 确保待保存数据不丢失。
 * 保存期间新修改不丢失：保存完成后检查 pending 标志，递归保存。
 */
export function useDebouncedSave<T>(
  value: T,
  saveFn: (value: T) => Promise<void>,
  options?: UseDebouncedSaveOptions<T>,
): UseDebouncedSaveResult {
  const { delay = 800, deepCompare = false, onError } = options ?? {};
  const [isSaving, setIsSaving] = useState(false);
  const [pending, setPending] = useState(false);

  // 用 ref 持有最新 value，避免闭包陈旧值
  const valueRef = useRef(value);
  valueRef.current = value;

  const saveFnRef = useRef(saveFn);
  saveFnRef.current = saveFn;

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstRender = useRef(true);
  const isSavingRef = useRef(false);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);

  // 上次保存的 value（用于深度比较）
  const lastSavedRef = useRef(value);

  // 执行保存（内部函数，不暴露）
  const doSave = useCallback(async (val: T): Promise<void> => {
    if (!mountedRef.current) return;
    setIsSaving(true);
    isSavingRef.current = true;
    try {
      await saveFnRef.current(val);
      lastSavedRef.current = val;
      if (mountedRef.current) {
        setPending(false);
        pendingRef.current = false;
      }
    } catch (err) {
      onErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (mountedRef.current) {
        setIsSaving(false);
      }
      isSavingRef.current = false;

      // 保存期间若有新修改，递归保存
      if (mountedRef.current && pendingRef.current) {
        setPending(false);
        pendingRef.current = false;
        await doSave(valueRef.current);
      }
    }
  }, []);

  // 清理定时器
  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 值变化 → 重置防抖定时器
  useEffect(() => {
    // 首次渲染跳过
    if (isFirstRender.current) {
      isFirstRender.current = false;
      lastSavedRef.current = value;
      return;
    }

    // 深度比较：相同值不触发
    if (deepCompare) {
      if (JSON.stringify(value) === JSON.stringify(lastSavedRef.current)) {
        return;
      }
    }

    clearTimer();
    setPending(true);
    pendingRef.current = true;

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (mountedRef.current) {
        pendingRef.current = false;
        setPending(false);
        doSave(valueRef.current);
      }
    }, delay);

    return () => {
      // cleanup by unmount handler
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, delay, deepCompare]);

  // 组件卸载时执行 flush
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
      // 组件卸载时，如果有待保存数据，立即保存
      if (pendingRef.current) {
        setIsSaving(true);
        isSavingRef.current = true;
        saveFnRef.current(valueRef.current)
          .then(() => {
            lastSavedRef.current = valueRef.current;
          })
          .catch((err) => {
            onErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
          })
          .finally(() => {
            pendingRef.current = false;
          });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // flush: 立即执行待处理保存
  const flush = useCallback(async (): Promise<void> => {
    clearTimer();
    if (pendingRef.current) {
      pendingRef.current = false;
      if (mountedRef.current) {
        setPending(false);
      }
      await doSave(valueRef.current);
    }
  }, [clearTimer, doSave]);

  return { isSaving, pending, flush };
}