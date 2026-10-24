/** 调模型：一次调用、一次重试、超时即放弃。
 *
 *  重试只针对「服务端可能自愈」的失败（429 / 5xx）；结构错误重试无益，直接降级。
 *  密钥只进请求头，绝不进日志或错误信息——这是零信任那条线的具体落点。
 */

import { fail, type ErrorCode, type Result } from '../model'
import type { Trajectory } from '../model'
import { complete, type CompleteFailure } from '../llm/complete'
import { extractContent, inspectResponse } from '../llm/response'
import { buildMessages, DIGEST_DEFAULTS, type DigestOptions } from './prompt'
import { parseJudgement } from './parse'
import type { LlmTransport, SemanticFinding } from './types'

export interface JudgeOptions {
  transport: LlmTransport
  /** OpenAI 兼容的 chat/completions 地址。 */
  url: string
  model: string
  apiKey: string
  timeoutMs?: number
  retries?: number
  retryDelayMs?: number
  maxFindings?: number
  /** 输出预算，必须显式给：推理型模型会把额度先花在 reasoning 上，
   *  不设则会拿供应商默认值，长轨迹很容易被截断成「空内容」（实测踩过）。 */
  maxTokens?: number
  digest?: DigestOptions
  signal?: AbortSignal
}

/** 输出预算：判定 JSON 本身不到 500 token，其余是留给 reasoning 的余地。 */
export const DEFAULT_MAX_TOKENS = 4096

export async function judgeTrajectory(
  trajectory: Trajectory,
  options: JudgeOptions,
): Promise<Result<SemanticFinding[]>> {
  const messages = buildMessages(trajectory, options.digest ?? DIGEST_DEFAULTS)
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  const body = JSON.stringify({
    model: options.model,
    temperature: 0,
    max_tokens: maxTokens,
    messages,
  })

  const result = await complete({
    transport: options.transport,
    url: options.url,
    model: options.model,
    apiKey: options.apiKey,
    body,
    // 20s 是纯文本模型的余量；推理型模型单条判定实测已要 10s+，超时必须跟着放宽。
    timeoutMs: options.timeoutMs ?? 60_000,
    retries: options.retries,
    retryDelayMs: options.retryDelayMs,
    signal: options.signal,
  })

  if (!result.ok) {
    const mapped = judgeFailure(result.failure)
    return fail(mapped.code, mapped.message, mapped.detail)
  }

  const content = extractContent(result.text)
  if (!content) {
    const shape = inspectResponse(result.text)
    // 「思考把额度吃光」和「模型什么都没说」是两种故障：前者调大预算即可，
    // 后者是端点问题。压成同一句话，用户只能靠猜。
    return fail(
      'analysis-failed',
      shape.finishReason === 'length'
        ? `模型输出被 max_tokens=${maxTokens} 截断（思考已占 ${shape.reasoningChars} 字），未产出可用内容`
        : '模型响应里没有可用内容',
      {
        finishReason: shape.finishReason ?? 'unknown',
        reasoningChars: shape.reasoningChars,
        maxTokens,
      },
    )
  }

  return parseJudgement(content, {
    stepCount: trajectory.steps.length,
    maxFindings: options.maxFindings,
  })
}

/** 把共享的失败形状翻回语义复核自己的措辞（既有文案与测试都以它为准）。 */
function judgeFailure(failure: CompleteFailure): {
  code: ErrorCode
  message: string
  detail?: Record<string, unknown>
} {
  switch (failure.kind) {
    case 'aborted':
      return { code: 'aborted', message: '语义复核已取消' }
    case 'timeout':
      return { code: 'analysis-failed', message: '语义复核超时' }
    case 'http':
      return {
        code: 'analysis-failed',
        message: `语义复核请求失败（HTTP ${failure.status}）`,
        detail: { status: failure.status, body: failure.body },
      }
    case 'transport':
      return { code: 'analysis-failed', message: '语义复核请求异常', detail: { reason: failure.reason } }
  }
}

/** 响应解析（取内容 / 看形状）已抽到 core/llm/response.ts：
 *  智能体读的是同一种响应，两处各写一份兼容分支迟早只改一处。 */
export { extractContent, inspectResponse, type ResponseShape } from '../llm/response'