/** 一次带超时、带一次重试的模型调用。
 *
 *  重试只针对「服务端可能自愈」的失败（429 / 5xx）；结构错误重试无益，直接降级。
 *  取消要分清两种来源：调用方主动 abort（`aborted`）与本地超时（`timeout`）。
 *  把两者混成一句话，用户会以为是自己按错了什么。
 *
 *  这个函数**不解析**响应体：语义复核读 `message.content`，智能体还要读
 *  `tool_calls`。解析留给各自的调用方，重试与超时只有这一份。
 */

import { RETRYABLE_STATUS, sleep, withTimeout, type LlmTransport } from './transport'

export interface CompleteRequest {
  transport: LlmTransport
  url: string
  model: string
  apiKey: string
  /** 已序列化的请求体。 */
  body: string
  timeoutMs: number
  retries?: number
  retryDelayMs?: number
  signal?: AbortSignal
}

export type CompleteFailure =
  | { kind: 'aborted' }
  | { kind: 'timeout' }
  | { kind: 'http'; status: number; body: string }
  | { kind: 'transport'; reason: string }

export type CompleteResult = { ok: true; text: string } | { ok: false; failure: CompleteFailure }

export async function complete(request: CompleteRequest): Promise<CompleteResult> {
  const retries = request.retries ?? 1
  const retryDelayMs = request.retryDelayMs ?? 800

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // 进来就已被取消：不要再发请求。注册 listener 对已派发的事件无效。
    if (request.signal?.aborted) return { ok: false, failure: { kind: 'aborted' } }

    const controller = new AbortController()
    const abortFromCaller = () => controller.abort()
    request.signal?.addEventListener('abort', abortFromCaller, { once: true })

    try {
      const response = await withTimeout(
        request.transport({
          url: request.url,
          model: request.model,
          apiKey: request.apiKey,
          body: request.body,
          signal: controller.signal,
        }),
        request.timeoutMs,
        () => controller.abort(),
      )

      if (!response.ok) {
        if (RETRYABLE_STATUS(response.status) && attempt < retries) {
          await sleep(retryDelayMs)
          continue
        }
        return {
          ok: false,
          // 只留前 200 字，避免把整页 HTML 错误页塞进报告
          failure: { kind: 'http', status: response.status, body: response.text.slice(0, 200) },
        }
      }

      return { ok: true, text: response.text }
    } catch (error) {
      if (request.signal?.aborted) return { ok: false, failure: { kind: 'aborted' } }
      const timedOut = error instanceof Error && error.message === 'timeout'
      if (attempt >= retries) {
        return {
          ok: false,
          failure: timedOut
            ? { kind: 'timeout' }
            : { kind: 'transport', reason: error instanceof Error ? error.message : String(error) },
        }
      }
      await sleep(retryDelayMs)
    } finally {
      request.signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  return { ok: false, failure: { kind: 'transport', reason: 'exhausted' } }
}
