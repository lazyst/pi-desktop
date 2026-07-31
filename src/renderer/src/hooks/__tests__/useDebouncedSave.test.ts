// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedSave } from '../useDebouncedSave';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDebouncedSave', () => {
  it('calls saveFn after delay when value changes', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ val }) => useDebouncedSave(val, saveFn, { delay: 800 }),
      { initialProps: { val: 'initial' } },
    );

    // 首次渲染不触发保存
    expect(saveFn).not.toHaveBeenCalled();

    rerender({ val: 'changed' });

    // 防抖期内不触发
    vi.advanceTimersByTime(500);
    expect(saveFn).not.toHaveBeenCalled();

    // 超过防抖期后触发
    vi.advanceTimersByTime(300);
    await vi.waitFor(() => {
      expect(saveFn).toHaveBeenCalledTimes(1);
    });
    expect(saveFn).toHaveBeenCalledWith('changed');
  });

  it('debounces multiple rapid changes into a single save', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ val }) => useDebouncedSave(val, saveFn, { delay: 800 }),
      { initialProps: { val: 0 } },
    );

    rerender({ val: 1 });
    vi.advanceTimersByTime(200);
    rerender({ val: 2 });
    vi.advanceTimersByTime(200);
    rerender({ val: 3 });
    vi.advanceTimersByTime(200);
    rerender({ val: 4 });
    vi.advanceTimersByTime(200);

    // 此时防抖尚未触发（重新计时了）
    expect(saveFn).not.toHaveBeenCalled();

    // 等待完整防抖期
    vi.advanceTimersByTime(800);
    await vi.waitFor(() => {
      expect(saveFn).toHaveBeenCalledTimes(1);
    });
    // 保存最新值
    expect(saveFn).toHaveBeenCalledWith(4);
  });

  it('does not call saveFn on initial mount', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useDebouncedSave('initial', saveFn, { delay: 800 }));

    vi.advanceTimersByTime(800);
    await vi.waitFor(() => {
      expect(saveFn).not.toHaveBeenCalled();
    });
  });

  it('calls saveFn again after save completes if new changes arrived during save', async () => {
    // 让第一次 save 耗时 200ms
    const saveFn = vi.fn().mockImplementation(async (val: string) => {
      await new Promise((r) => setTimeout(r, 200));
    });
    const { rerender } = renderHook(
      ({ val }) => useDebouncedSave(val, saveFn, { delay: 100 }),
      { initialProps: { val: 'a' } },
    );

    // 触发第一次保存
    rerender({ val: 'b' });
    vi.advanceTimersByTime(100);
    await vi.waitFor(() => {
      expect(saveFn).toHaveBeenCalledTimes(1);
    });
    expect(saveFn).toHaveBeenCalledWith('b');

    // 在保存期间修改值
    rerender({ val: 'c' });
    // 保存完成后应自动递归保存
    vi.advanceTimersByTime(300);
    await vi.waitFor(() => {
      expect(saveFn).toHaveBeenCalledTimes(2);
    });
    expect(saveFn).toHaveBeenCalledWith('c');
  });

  it('flushes pending save on unmount', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = renderHook(
      ({ val }) => useDebouncedSave(val, saveFn, { delay: 800 }),
      { initialProps: { val: 'a' } },
    );

    rerender({ val: 'b' });
    // 防抖尚未触发
    vi.advanceTimersByTime(100);

    // 卸载时应 flush
    unmount();

    await vi.waitFor(() => {
      expect(saveFn).toHaveBeenCalledTimes(1);
    });
    expect(saveFn).toHaveBeenCalledWith('b');
  });

  it('reports isSaving and pending state correctly', async () => {
    const saveFn = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    const { result, rerender } = renderHook(
      ({ val }) => useDebouncedSave(val, saveFn, { delay: 100 }),
      { initialProps: { val: 'a' } },
    );

    // 初始状态
    expect(result.current.isSaving).toBe(false);
    expect(result.current.pending).toBe(false);

    // 修改值 → pending
    rerender({ val: 'b' });
    expect(result.current.pending).toBe(true);

    // 防抖触发 → 开始保存 → isSaving（异步 state 更新，用 waitFor 等待）
    vi.advanceTimersByTime(100);
    await vi.waitFor(() => {
      expect(result.current.isSaving).toBe(true);
    });

    // 保存完成
    vi.advanceTimersByTime(100);
    await vi.waitFor(() => {
      expect(result.current.isSaving).toBe(false);
      expect(result.current.pending).toBe(false);
    });
  });

  it('calls onError when saveFn throws', async () => {
    const onError = vi.fn();
    const saveFn = vi.fn().mockRejectedValue(new Error('save failed'));
    const { rerender } = renderHook(
      ({ val }) => useDebouncedSave(val, saveFn, { delay: 100, onError }),
      { initialProps: { val: 'a' } },
    );

    rerender({ val: 'b' });
    vi.advanceTimersByTime(100);

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(new Error('save failed'));
    });
  });

  it('does not re-save when deepCompare is true and object content is same', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const obj = { key: 'value' };
    const { rerender } = renderHook(
      ({ val }) => useDebouncedSave(val, saveFn, { delay: 100, deepCompare: true }),
      { initialProps: { val: obj } },
    );

    // 首次渲染跳过
    vi.advanceTimersByTime(100);
    expect(saveFn).not.toHaveBeenCalled();

    // 相同内容的新对象不触发
    rerender({ val: { key: 'value' } });
    vi.advanceTimersByTime(100);
    expect(saveFn).not.toHaveBeenCalled();

    // 不同内容触发
    rerender({ val: { key: 'new-value' } });
    vi.advanceTimersByTime(100);
    await vi.waitFor(() => {
      expect(saveFn).toHaveBeenCalledTimes(1);
    });
    expect(saveFn).toHaveBeenCalledWith({ key: 'new-value' });
  });

  it('flush() immediately saves pending changes', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ val }) => useDebouncedSave(val, saveFn, { delay: 800 }),
      { initialProps: { val: 'a' } },
    );

    rerender({ val: 'b' });

    // 手动 flush
    await act(async () => {
      await result.current.flush();
    });

    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(saveFn).toHaveBeenCalledWith('b');
  });
});