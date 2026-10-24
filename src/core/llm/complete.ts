/** 一次带超时、带一次重试的模型调用。
 *
 *  重试只针对「请求很可能没处理成功」的失败：429 / 5xx，以及连接层的错误（断连、拒绝连接）。
 *  **超时不重试**：一个超时的请求，服务端可能已经收到并开始计费，再发一遍就是付两次，
 *  而且多半只是把同样的慢再等一遍。结构错误重试无益，直接降级。
 *
 *  `totalTimeoutMs` 约束的是**整个调用**（含重试与退避），不只是单次尝试。没有它，
 *  「单次 90 秒」加一次重试就是 180 秒，套在一个 180 秒的总预算里就等于没有预算。
 *
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
  /** 单次尝试的超时。 */
  timeoutMs: number
  /** 整个调用（含重试与退避）的总时限；省略则只受 `timeoutMs` 约束。 */
  totalTimeoutMs?: number
  retries?: number
  retryDelayMs?: number
  signal?: AbortSignal
}

export type CompleteFailure =
  | { kind: 'aborted' }
  /** `budgetExhausted`：超时是因为总时限用完了，不是端点单次太慢。调用方据此区分
   *  「预算到了」与「端点有问题」——前者是未收敛，后者是故障。 */
  | { kind: 'timeout'; budgetExhausted?: true }
  | { kind: 'http'; status: number; body: string }
  | { kind: 'transport'; reason: string }

export type CompleteResult = { ok: true; text: string } | { ok: false; failure: CompleteFailure }

export async function complete(request: CompleteRequest): Promise<CompleteResult> {
  const retries = request.retries ?? 1
  const retryDelayMs = request.retryDelayMs ?? 800
  const startedAt = Date.now()
  const remaining = (): number =>
    request.totalTimeoutMs === undefined ? Infinity : request.totalTimeoutMs - (Date.now() - startedAt)

  /** 上一次尝试的真实失败。预算在「等着重试」时用完，要报它，而不是一个盖住真因的超时。 */
  let lastFailure: CompleteFailure | null = null

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // 进来就已被取消：不要再发请求。注册 listener 对已派发的事件无效。
    if (request.signal?.aborted) return { ok: false, failure: { kind: 'aborted' } }

    const left = remaining()
    if (left <= 0) return { ok: false, failure: lastFailure ?? { kind: 'timeout', budgetExhausted: true } }
    // 这次尝试至多只能用掉剩下的时间；被钳住时，随之而来的超时就是「预算到了」。
    const clamped = left < request.timeoutMs
    const attemptTimeout = clamped ? left : request.timeoutMs

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
        attemptTimeout,
        () => controller.abort(),
      )

      if (!response.ok) {
        // 只留前 200 字，避免把整页 HTML 错误页塞进报告
        const failure: CompleteFailure = { kind: 'http', status: response.status, body: response.text.slice(0, 200) }
        if (RETRYABLE_STATUS(response.status) && attempt < retries) {
          lastFailure = failure
          await sleep(Math.min(retryDelayMs, Math.max(0, remaining())))
          continue
        }
        return { ok: false, failure }
      }

      return { ok: true, text: response.text }
    } catch (error) {
      if (request.signal?.aborted) return { ok: false, failure: { kind: 'aborted' } }
      // 超时不重试，见文件头。
      if (error instanceof Error && error.message === 'timeout') {
        return { ok: false, failure: clamped ? { kind: 'timeout', budgetExhausted: true } : { kind: 'timeout' } }
      }
      const failure: CompleteFailure = {
        kind: 'transport',
        reason: error instanceof Error ? error.message : String(error),
      }
      if (attempt >= retries) return { ok: false, failure }
      lastFailure = failure
      await sleep(Math.min(retryDelayMs, Math.max(0, remaining())))
    } finally {
      request.signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  return { ok: false, failure: { kind: 'transport', reason: 'exhausted' } }
}
