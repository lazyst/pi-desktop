// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  registerTerminalOutputAckCredits,
  discardInFlightTerminalOutputAckCredits,
} from '../ack-credit';

describe('ack-credit ACK 信用追踪', () => {
  describe('registerTerminalOutputAckCredits', () => {
    it('空数组返回 undefined', () => {
      const terminal = {};
      const result = registerTerminalOutputAckCredits(terminal, []);
      expect(result).toBeUndefined();
    });

    it('非空数组返回 complete 函数', () => {
      const terminal = {};
      const credit = vi.fn();
      const complete = registerTerminalOutputAckCredits(terminal, [credit]);
      expect(complete).toBeInstanceOf(Function);
    });

    it('调用 complete 按序执行所有 credit', () => {
      const terminal = {};
      const order: number[] = [];
      const credit1 = () => order.push(1);
      const credit2 = () => order.push(2);
      const credit3 = () => order.push(3);

      const complete = registerTerminalOutputAckCredits(terminal, [credit1, credit2, credit3])!;
      complete();

      expect(order).toEqual([1, 2, 3]);
    });

    it('重复调用 complete 只执行一次 credit', () => {
      const terminal = {};
      const credit = vi.fn();
      const complete = registerTerminalOutputAckCredits(terminal, [credit])!;

      complete();
      complete();
      complete();

      expect(credit).toHaveBeenCalledTimes(1);
    });

    it('多次注册不同分组，各自的 complete 独立触发', () => {
      const terminal = {};
      const creditA = vi.fn();
      const creditB = vi.fn();

      const completeA = registerTerminalOutputAckCredits(terminal, [creditA])!;
      const completeB = registerTerminalOutputAckCredits(terminal, [creditB])!;

      completeA();
      expect(creditA).toHaveBeenCalledTimes(1);
      expect(creditB).not.toHaveBeenCalled();

      completeB();
      expect(creditB).toHaveBeenCalledTimes(1);
    });

    it('终端对象不同时信用互不干扰', () => {
      const terminalA = {};
      const terminalB = {};
      const creditA = vi.fn();
      const creditB = vi.fn();

      registerTerminalOutputAckCredits(terminalA, [creditA]);
      registerTerminalOutputAckCredits(terminalB, [creditB]);

      discardInFlightTerminalOutputAckCredits(terminalA);
      expect(creditA).toHaveBeenCalledTimes(1);
      expect(creditB).not.toHaveBeenCalled();
    });
  });

  describe('discardInFlightTerminalOutputAckCredits', () => {
    it('丢弃所有飞行中信用', () => {
      const terminal = {};
      const credit1 = vi.fn();
      const credit2 = vi.fn();

      registerTerminalOutputAckCredits(terminal, [credit1]);
      registerTerminalOutputAckCredits(terminal, [credit2]);

      discardInFlightTerminalOutputAckCredits(terminal);

      expect(credit1).toHaveBeenCalledTimes(1);
      expect(credit2).toHaveBeenCalledTimes(1);
    });

    it('无可丢弃信用时静默返回', () => {
      const terminal = {};
      // 不应抛出
      expect(() => discardInFlightTerminalOutputAckCredits(terminal)).not.toThrow();
    });

    it('丢弃后新注册的信用仍可正常使用', () => {
      const terminal = {};

      // 注册一批并丢弃
      registerTerminalOutputAckCredits(terminal, [vi.fn()]);
      discardInFlightTerminalOutputAckCredits(terminal);

      // 再注册一批
      const credit = vi.fn();
      const complete = registerTerminalOutputAckCredits(terminal, [credit])!;
      complete();

      expect(credit).toHaveBeenCalledTimes(1);
    });
  });
});