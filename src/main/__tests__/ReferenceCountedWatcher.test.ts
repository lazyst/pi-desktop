import { describe, it, expect, vi } from 'vitest';
import { ReferenceCountedWatcher } from '../shared/ReferenceCountedWatcher';

describe('ReferenceCountedWatcher', () => {
  it('watch a new key calls start and sets refs to 1', () => {
    const w = new ReferenceCountedWatcher<string>();
    const start = vi.fn(() => vi.fn());

    w.watch('a', start);

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith('a');
  });

  it('watch an existing key increments refs without calling start again', () => {
    const w = new ReferenceCountedWatcher<string>();
    const start = vi.fn(() => vi.fn());

    w.watch('a', start);
    w.watch('a', start);

    expect(start).toHaveBeenCalledTimes(1); // 只调用了一次
  });

  it('unwatch decrements refs and calls stop when refs reaches 0', () => {
    const w = new ReferenceCountedWatcher<string>();
    const stop = vi.fn();
    const start = vi.fn(() => stop);

    w.watch('a', start);
    w.unwatch('a');

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('unwatch multiple times only calls stop once when refs reaches 0', () => {
    const w = new ReferenceCountedWatcher<string>();
    const stop = vi.fn();
    const start = vi.fn(() => stop);

    w.watch('a', start);
    w.unwatch('a');
    w.unwatch('a'); // 第二次 unwatch，key 已不存在，静默忽略

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('unwatch with multiple refs does not call stop until all refs are consumed', () => {
    const w = new ReferenceCountedWatcher<string>();
    const stop = vi.fn();
    const start = vi.fn(() => stop);

    w.watch('a', start);
    w.watch('a', start); // refs = 2
    w.unwatch('a'); // refs = 1
    expect(stop).not.toHaveBeenCalled();

    w.unwatch('a'); // refs = 0
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('unwatch a non-existent key is a no-op', () => {
    const w = new ReferenceCountedWatcher<string>();
    expect(() => w.unwatch('nonexistent')).not.toThrow();
  });

  it('dispose calls stop for all keys and clears the map', () => {
    const w = new ReferenceCountedWatcher<string>();
    const stopA = vi.fn();
    const stopB = vi.fn();
    const start = vi.fn((key: string) => (key === 'a' ? stopA : stopB));

    w.watch('a', start);
    w.watch('b', start);
    w.dispose();

    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopB).toHaveBeenCalledTimes(1);
    // 再 unwatch 不应触发任何操作
    expect(() => w.unwatch('a')).not.toThrow();
  });

  it('supports numeric keys via generic type parameter', () => {
    const w = new ReferenceCountedWatcher<number>();
    const start = vi.fn(() => vi.fn());

    w.watch(42, start);
    expect(start).toHaveBeenCalledWith(42);

    w.unwatch(42);
    expect(start).toHaveBeenCalledTimes(1);
  });
});