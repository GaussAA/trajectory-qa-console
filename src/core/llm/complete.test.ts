/** `complete()` 是语义复核和智能体共用的那一份超时与重试。
 *
 *  这里锁住三件事：整体时限能约束「重试」而不只是单次尝试；超时不重试（重试一个已经
 *  超时的请求，服务端可能已经处理并计费，再发一遍就是付两次）；可恢复的失败（429/5xx）
 *  照旧重试。时间相关的断言都留了很宽的余量，只为抓住「又退回去了」，不是性能基准。 */

import { describe, expect, it } from 'vitest'
import { complete, type CompleteRequest } from './complete'
import type { LlmRequest, LlmResponse, LlmTransport } from './transport'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function request(transport: LlmTransport, extra: Partial<CompleteRequest> = {}): CompleteRequest {
  return {
    transport,
    url: 'https://llm.test/v1/chat/completions',
    model: 'm',
    apiKey: 'k',
    body: '{}',
    timeoutMs: 1000,
    retryDelayMs: 0,
    ...extra,
  }
}

/** 永不返回的端点：只有超时才能结束这次调用。 */
const hang: LlmTransport = () => new Promise<LlmResponse>(() => undefined)

describe('complete: timeouts are not retried', () => {
  it('sends a timed-out request exactly once', async () => {
    let sent = 0
    const transport: LlmTransport = (input: LlmRequest) => {
      sent += 1
      return hang(input)
    }
    const result = await complete(request(transport, { timeoutMs: 30, retries: 1 }))

    // 没有总时限，这是端点单次太慢：不带 budgetExhausted
    expect(result).toEqual({ ok: false, failure: { kind: 'timeout' } })
    expect(sent).toBe(1)
  })

  it('still retries a failure the server may recover from', async () => {
    let sent = 0
    const transport: LlmTransport = async () => {
      sent += 1
      return sent === 1 ? { ok: false, status: 503, text: 'busy' } : { ok: true, status: 200, text: 'fine' }
    }
    const result = await complete(request(transport, { retries: 1 }))

    expect(result).toEqual({ ok: true, text: 'fine' })
    expect(sent).toBe(2)
  })

  it('still retries a dropped connection', async () => {
    let sent = 0
    const transport: LlmTransport = async () => {
      sent += 1
      if (sent === 1) throw new Error('ECONNRESET')
      return { ok: true, status: 200, text: 'fine' }
    }
    expect((await complete(request(transport, { retries: 1 }))).ok).toBe(true)
    expect(sent).toBe(2)
  })
})

describe('complete: totalTimeoutMs bounds the whole call, retries included', () => {
  it('does not give the retry a fresh full timeout', async () => {
    // 每次尝试都慢 300ms 后返回 500。总时限 400ms：第一次耗掉 300，重试只剩约 100。
    // 没有总时限时两次各 300，共约 600ms。
    const transport: LlmTransport = async () => {
      await sleep(300)
      return { ok: false, status: 500, text: 'slow and broken' }
    }
    const started = Date.now()
    const result = await complete(request(transport, { retries: 1, totalTimeoutMs: 400 }))
    const elapsed = Date.now() - started

    expect(result.ok).toBe(false)
    expect(elapsed).toBeLessThan(520)
  })

  it('clamps a single attempt to what is left', async () => {
    const started = Date.now()
    const result = await complete(request(hang, { timeoutMs: 5000, totalTimeoutMs: 80 }))

    // 超时是总时限造成的，不是端点单次太慢：要带上 budgetExhausted，调用方才分得清
    expect(result).toEqual({ ok: false, failure: { kind: 'timeout', budgetExhausted: true } })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('does not send anything when the budget is already spent', async () => {
    let sent = 0
    const transport: LlmTransport = async () => {
      sent += 1
      return { ok: true, status: 200, text: 'x' }
    }
    const result = await complete(request(transport, { totalTimeoutMs: 0 }))

    expect(result).toEqual({ ok: false, failure: { kind: 'timeout', budgetExhausted: true } })
    expect(sent).toBe(0)
  })

  it('reports the real error, not a timeout, when the budget runs out while waiting to retry', async () => {
    const transport: LlmTransport = async () => ({ ok: false, status: 500, text: 'upstream down' })
    const result = await complete(request(transport, { retries: 1, retryDelayMs: 200, totalTimeoutMs: 60 }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    // 用户要看到的是「上游 500」，不是一个把真正原因盖住的「超时」
    expect(result.failure).toMatchObject({ kind: 'http', status: 500 })
  })

  it('leaves behaviour unchanged when no total is given', async () => {
    let sent = 0
    const transport: LlmTransport = async () => {
      sent += 1
      return sent === 1
        ? { ok: false, status: 429, text: 'slow down' }
        : { ok: true, status: 200, text: 'ok' }
    }
    expect((await complete(request(transport, { retries: 1 }))).ok).toBe(true)
  })
})
