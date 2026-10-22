/** 调模型：一次调用、一次重试、超时即放弃。
 *
 *  重试只针对「服务端可能自愈」的失败（429 / 5xx）；结构错误重试无益，直接降级。
 *  密钥只进请求头，绝不进日志或错误信息——这是零信任那条线的具体落点。
 */

import { fail, type Result } from '../model'
import type { Trajectory } from '../model'
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
  digest?: DigestOptions
  signal?: AbortSignal
}

const RETRYABLE_STATUS = (status: number) => status === 429 || status >= 500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new Error('timeout'))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export async function judgeTrajectory(
  trajectory: Trajectory,
  options: JudgeOptions,
): Promise<Result<SemanticFinding[]>> {
  const messages = buildMessages(trajectory, options.digest ?? DIGEST_DEFAULTS)
  const body = JSON.stringify({
    model: options.model,
    temperature: 0,
    messages,
  })

  const retries = options.retries ?? 1
  const timeoutMs = options.timeoutMs ?? 20_000
  const retryDelayMs = options.retryDelayMs ?? 800

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // 进来就已被取消：不要再发请求。注册 listener 对已派发的事件无效。
    if (options.signal?.aborted) return fail('aborted', '语义复核已取消')

    const controller = new AbortController()
    const abortFromCaller = () => controller.abort()
    options.signal?.addEventListener('abort', abortFromCaller, { once: true })

    try {
      const response = await withTimeout(
        options.transport({
          url: options.url,
          model: options.model,
          apiKey: options.apiKey,
          body,
          signal: controller.signal,
        }),
        timeoutMs,
        () => controller.abort(),
      )

      if (!response.ok) {
        if (RETRYABLE_STATUS(response.status) && attempt < retries) {
          await sleep(retryDelayMs)
          continue
        }
        return fail('analysis-failed', `语义复核请求失败（HTTP ${response.status}）`, {
          status: response.status,
          // 只留前 200 字，避免把整页 HTML 错误页塞进报告
          body: response.text.slice(0, 200),
        })
      }

      const content = extractContent(response.text)
      if (!content) return fail('analysis-failed', '模型响应里没有可用内容')

      return parseJudgement(content, {
        stepCount: trajectory.steps.length,
        maxFindings: options.maxFindings,
      })
    } catch (error) {
      if (options.signal?.aborted) return fail('aborted', '语义复核已取消')
      const timedOut = error instanceof Error && error.message === 'timeout'
      if (attempt >= retries) {
        return fail('analysis-failed', timedOut ? '语义复核超时' : '语义复核请求异常', {
          reason: error instanceof Error ? error.message : String(error),
        })
      }
      await sleep(retryDelayMs)
    } finally {
      options.signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  return fail('analysis-failed', '语义复核未得到结果')
}

/** 兼容 OpenAI 的 `choices[0].message.content`，也接受直接返回文本的代理。 */
export function extractContent(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as {
      choices?: { message?: { content?: unknown } }[]
      content?: unknown
      output_text?: unknown
    }
    const choice = parsed.choices?.[0]?.message?.content
    if (typeof choice === 'string' && choice.trim()) return choice
    if (Array.isArray(choice)) {
      // 部分供应商把 content 拆成 parts
      const text = choice
        .map((part) =>
          typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text) : '',
        )
        .join('')
      if (text.trim()) return text
    }
    if (typeof parsed.content === 'string') return parsed.content
    if (typeof parsed.output_text === 'string') return parsed.output_text
    return null
  } catch {
    // 不是 JSON：某些本地代理直接回文本
    return raw.trim() ? raw : null
  }
}
