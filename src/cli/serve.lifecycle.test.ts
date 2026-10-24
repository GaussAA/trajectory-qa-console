/** serve 的请求生命周期：客户端断连要停掉模型调用，并发名额要还回来，模型失败要走 done 事件。 */

import { describe, expect, it, vi } from 'vitest'
import type { LlmTransport } from '../core/llm/transport'
import { SUBMITTED, diagnose, dropAfterFirstChunk, session, start } from './test-support'

/** 一直挂着、直到被取消的端点：用来把「正在跑」的那个名额占住。 */
function blocking() {
  const waiting: (() => void)[] = []
  const transport: LlmTransport = (input) =>
    new Promise((resolve, reject) => {
      input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      waiting.push(() => resolve({ ok: true, status: 200, text: SUBMITTED }))
    })
  return { transport, release: () => waiting.splice(0).forEach((fn) => fn()), pending: () => waiting.length }
}

describe('agent server client disconnect', () => {
  it('stops the agent run when the client disconnects, instead of spending on', async () => {
    // 端点一直挂着，直到收到取消信号。没有断连处理时，这次调用会一直挂到单次超时，
    // 模型额度就这样烧在一个没人在看的请求上。
    let seen: AbortSignal | undefined
    let calls = 0
    const transport: LlmTransport = (input) => {
      calls += 1
      seen = input.signal
      return new Promise((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    const server = await start({ transport })
    try {
      await dropAfterFirstChunk(server.port, JSON.stringify({ sessions: [session()] }))

      await vi.waitFor(() => expect(seen?.aborted).toBe(true), { timeout: 2000 })
      expect(calls).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('does not abort a run whose client stays connected', async () => {
    let aborted = false
    const transport: LlmTransport = async (input) => {
      input.signal?.addEventListener('abort', () => {
        aborted = true
      })
      return { ok: true, status: 200, text: SUBMITTED }
    }
    const server = await start({ transport })
    try {
      const result = await diagnose(server.base, { sessions: [session()] })
      expect(result.lines.at(-1)?.type).toBe('done')
      expect(aborted).toBe(false)
    } finally {
      await server.close()
    }
  })

  it('reports a model failure as a done event, not a broken stream', async () => {
    const failing: LlmTransport = async () => ({ ok: false, status: 500, text: 'down' })
    const server = await start({ transport: failing })
    try {
      const result = await diagnose(server.base, { sessions: [session()] })
      const last = result.lines.at(-1) as unknown as { type: string; run: { ok: boolean; error?: { message: string } } }
      expect(last.type).toBe('done')
      expect(last.run.ok).toBe(false)
      expect(last.run.error?.message).toContain('500')
    } finally {
      await server.close()
    }
  })
})

describe('agent server concurrency limit', () => {
  it('turns away a diagnosis beyond the concurrency limit with 429, and frees the slot when one ends', async () => {
    const gate = blocking()
    const server = await start({ transport: gate.transport, maxConcurrent: 1 })
    try {
      const first = diagnose(server.base, { sessions: [session()] })
      await vi.waitFor(() => expect(gate.pending()).toBe(1), { timeout: 2000 })

      const second = await fetch(`${server.base}/api/diagnose`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessions: [session()] }),
      })
      expect(second.status).toBe(429)
      expect(second.headers.get('retry-after')).not.toBeNull()
      // 被拒的那个请求没有碰模型
      expect(gate.pending()).toBe(1)

      gate.release()
      expect((await first).status).toBe(200)

      // 第一个跑完，名额回来了
      const third = diagnose(server.base, { sessions: [session()] })
      await vi.waitFor(() => expect(gate.pending()).toBe(1), { timeout: 2000 })
      gate.release()
      expect((await third).status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('frees the slot when the client walks away mid-run', async () => {
    const gate = blocking()
    const server = await start({ transport: gate.transport, maxConcurrent: 1 })
    try {
      const body = JSON.stringify({ sessions: [session()] })
      await dropAfterFirstChunk(server.port, body)

      // 客户端走了：名额必须还回来，否则一次断连就把服务永久占满
      await vi.waitFor(
        async () => {
          const probe = await fetch(`${server.base}/api/diagnose`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          })
          expect(probe.status).not.toBe(429)
          probe.body?.cancel().catch(() => undefined)
        },
        { timeout: 3000 },
      )
    } finally {
      gate.release()
      await server.close()
    }
  })
})
