/** CLI 里与 LLM 端点相关的入口：serve 子命令与 --llm-timeout。 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXIT, main } from './main'
import { CLEAN, capture, cleanupTempDirs, tempDir, trace } from './test-support'

afterEach(cleanupTempDirs)

describe('serve subcommand', () => {
  it('refuses to start without LLM configuration', async () => {
    const { io, chunks } = capture()
    expect(await main(['serve'], io, { env: {} })).toBe(EXIT.error)
    expect(chunks.err).toContain('TQA_LLM_API_KEY')
  })

  it('starts, prints where it listens, and stops on the abort signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const { io, chunks } = capture()

    const code = await main(['serve', '--port', '0', '--token', 'abc'], io, {
      env: { TQA_LLM_BASE_URL: 'https://llm.test/v1', TQA_LLM_MODEL: 'm', TQA_LLM_API_KEY: 'k' },
      signal: controller.signal,
    })

    expect(code).toBe(EXIT.ok)
    // 端口 0 由系统分配，打印的必须是**实际**端口而不是命令行里的 0。
    expect(chunks.out).toContain('http://127.0.0.1:')
    expect(chunks.out).not.toContain('http://127.0.0.1:0\n')
    expect(chunks.out).toContain('agentToken')
  })

  it('warns when the bind address is not a loopback one', async () => {
    const controller = new AbortController()
    controller.abort()
    const { io, chunks } = capture()

    await main(['serve', '--port', '0', '--host', '0.0.0.0'], io, {
      env: { TQA_LLM_BASE_URL: 'https://llm.test/v1', TQA_LLM_MODEL: 'm', TQA_LLM_API_KEY: 'k' },
      signal: controller.signal,
    })

    expect(chunks.err).toContain('不是回环地址')
  })
})

describe('--llm-timeout', () => {
  const ENV = { TQA_LLM_BASE_URL: 'https://llm.test/v1', TQA_LLM_MODEL: 'm', TQA_LLM_API_KEY: 'k' }

  /** 挂住不回的传输层：只记下收到的 signal，超时由 complete() 去中止它。 */
  function hanging() {
    let signal: AbortSignal | undefined
    let markCalled: () => void = () => undefined
    const called = new Promise<void>((resolve) => {
      markCalled = resolve
    })
    const transport = (request: { signal?: AbortSignal }) => {
      signal = request.signal
      markCalled()
      return new Promise<never>((_, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    return { transport, called, aborted: () => signal?.aborted === true }
  }

  /** 在假时钟下跑一遍：返回请求在 beforeMs 与 afterMs 两个时刻是否已被中止。 */
  async function probe(args: string[], beforeMs: number, afterMs: number) {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const hang = hanging()
    const { io } = capture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const running = main([dir, ...args, '--quiet'], io, { env: ENV, transport: hang.transport })
      await hang.called
      await vi.advanceTimersByTimeAsync(beforeMs)
      const early = hang.aborted()
      await vi.advanceTimersByTimeAsync(afterMs - beforeMs)
      const late = hang.aborted()
      await running
      return { early, late }
    } finally {
      vi.useRealTimers()
    }
  }

  it('keeps the 60s default for semantic review', async () => {
    expect(await probe(['--semantic'], 59_000, 61_000)).toEqual({ early: false, late: true })
  })

  it('shortens the semantic request timeout', async () => {
    expect(await probe(['--semantic', '--llm-timeout', '8'], 7_000, 9_000)).toEqual({
      early: false,
      late: true,
    })
  })

  it('keeps the 90s default for the agent', async () => {
    expect(await probe(['--agent'], 89_000, 91_000)).toEqual({ early: false, late: true })
  })

  it('shortens the agent request timeout', async () => {
    expect(await probe(['--agent', '--llm-timeout', '8'], 7_000, 9_000)).toEqual({
      early: false,
      late: true,
    })
  })
})
