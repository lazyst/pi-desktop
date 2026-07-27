// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetWriteCompletionReportsForTests,
  runGuardedWriteCompletionStep
} from '../write-callback-guard'

beforeEach(() => {
  _resetWriteCompletionReportsForTests()
})

describe('runGuardedWriteCompletionStep', () => {
  it('能捕获同步 throw 并通过 console.error 报告异常', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() =>
        runGuardedWriteCompletionStep('test-step', () => {
          throw new RangeError('synthetic settle failure')
        })
      ).not.toThrow()
      expect(errorSpy).toHaveBeenCalledWith(
        '[terminal] write-completion step "test-step" threw',
        expect.any(RangeError)
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('每个上下文最多报告 5 次异常，防止 throw-per-write 循环刷日志', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (let i = 0; i < 20; i++) {
        runGuardedWriteCompletionStep('spammy-step', () => {
          throw new Error('always fails')
        })
      }
      // 前 5 次报告，之后静默吞掉
      expect(errorSpy).toHaveBeenCalledTimes(5)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('不同上下文独立计数', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (let i = 0; i < 10; i++) {
        runGuardedWriteCompletionStep('ctx-a', () => {
          throw new Error('fail')
        })
        runGuardedWriteCompletionStep('ctx-b', () => {
          throw new Error('fail')
        })
      }
      // 两个上下文各报告 5 次，共 10 次
      expect(errorSpy).toHaveBeenCalledTimes(10)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('正常执行的步骤透传运行，不报异常', () => {
    const step = vi.fn()
    runGuardedWriteCompletionStep('ok-step', step)
    expect(step).toHaveBeenCalledTimes(1)
  })

  it('正常执行的步骤不会调用 console.error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      runGuardedWriteCompletionStep('ok-step', () => {
        /* 正常执行，无事发生 */
      })
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('_resetWriteCompletionReportsForTests', () => {
  it('清空后异常计数重新开始', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // 先触发 5 次，达到上限
      for (let i = 0; i < 5; i++) {
        runGuardedWriteCompletionStep('reset-test', () => {
          throw new Error('fail')
        })
      }
      expect(errorSpy).toHaveBeenCalledTimes(5)

      // 再触发一次，被静默吞掉
      runGuardedWriteCompletionStep('reset-test', () => {
        throw new Error('fail')
      })
      expect(errorSpy).toHaveBeenCalledTimes(5) // 没有增加

      // 重置后计数归零
      _resetWriteCompletionReportsForTests()
      runGuardedWriteCompletionStep('reset-test', () => {
        throw new Error('fail')
      })
      expect(errorSpy).toHaveBeenCalledTimes(6) // 重新开始计数
    } finally {
      errorSpy.mockRestore()
    }
  })
})