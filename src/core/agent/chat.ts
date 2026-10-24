/** 一次「模型回合」：发消息 + 工具清单，收回文本与工具调用。
 *
 *  只做形状转换与解析，超时/重试交给 `core/llm/complete`。这样循环里没有
 *  任何重试逻辑，测试用假 transport 就能把每一轮钉死。
 */

import { fail, ok, type Result } from '../model'
import { complete } from '../llm/complete'
import { extractContent } from '../llm/response'
import type { LlmTransport } from '../llm/transport'
import type { AgentMessage, AgentToolCall, ChatReply, ToolSpec } from './types'

export interface ChatOptions {
  transport: LlmTransport
  url: string
  model: string
  apiKey: string
  maxTokens: number
  timeoutMs: number
  /** 这一回合（含重试）最多还能花多久；由循环按剩余的墙钟预算算出。 */
  totalTimeoutMs?: number
  retries?: number
  retryDelayMs?: number
  tools: ToolSpec[]
  signal?: AbortSignal
}

/** assistant 的 `tool_calls` 与 tool 的 `tool_call_id` 是 OpenAI 的线格式，
 *  改名会让每接一个新供应商都多一层翻译。 */
function toWire(message: AgentMessage): Record<string, unknown> {
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    }
  }
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.content }
  }
  return { role: message.role, content: message.content }
}

interface RawToolCall {
  id?: unknown
  function?: { name?: unknown; arguments?: unknown }
}

/** 容忍三种常见偏差：id 缺失、参数是对象而非字符串、字段整块缺失。
 *  参数非法 JSON 不在这里修——原样回灌给模型，让它自己看见错在哪。 */
function normalizeToolCalls(raw: unknown): AgentToolCall[] {
  if (!Array.isArray(raw)) return []
  const calls: AgentToolCall[] = []
  raw.forEach((item, index) => {
    const call = item as RawToolCall
    const name = call.function?.name
    if (typeof name !== 'string' || name.trim() === '') return
    const args = call.function?.arguments
    const text = typeof args === 'string' ? args : args === undefined ? '{}' : JSON.stringify(args)
    calls.push({
      id: typeof call.id === 'string' && call.id ? call.id : `call_${index}`,
      name,
      arguments: text,
    })
  })
  return calls
}

function numberAt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 解析一次响应。结构完全读不出来时才返回 null——那是端点问题，不是模型跑偏。 */
export function parseReply(raw: string): ChatReply | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 有些本地代理直接回文本
    const text = extractContent(raw)
    return text
      ? { content: text, toolCalls: [], finishReason: null, reasoningChars: 0, usage: { prompt: 0, completion: 0 } }
      : null
  }

  const record = parsed as {
    choices?: { message?: { content?: unknown; tool_calls?: unknown; reasoning?: unknown }; finish_reason?: unknown }[]
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
  }
  const choice = record.choices?.[0]
  if (!choice) {
    const text = extractContent(raw)
    return text
      ? { content: text, toolCalls: [], finishReason: null, reasoningChars: 0, usage: { prompt: 0, completion: 0 } }
      : null
  }

  const message = choice.message
  const content =
    typeof message?.content === 'string' && message.content.trim()
      ? message.content
      : (extractContent(raw) ?? '')
  const reasoning = message?.reasoning

  return {
    content,
    toolCalls: normalizeToolCalls(message?.tool_calls),
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    reasoningChars: typeof reasoning === 'string' ? reasoning.length : 0,
    usage: {
      prompt: numberAt(record.usage?.prompt_tokens),
      completion: numberAt(record.usage?.completion_tokens),
    },
  }
}

export async function chat(messages: AgentMessage[], options: ChatOptions): Promise<Result<ChatReply>> {
  const body: Record<string, unknown> = {
    model: options.model,
    temperature: 0,
    max_tokens: options.maxTokens,
    messages: messages.map(toWire),
  }
  // 空数组会让部分端点直接 400；没有工具就干脆不提这个字段。
  if (options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
  }

  const result = await complete({
    transport: options.transport,
    url: options.url,
    model: options.model,
    apiKey: options.apiKey,
    body: JSON.stringify(body),
    timeoutMs: options.timeoutMs,
    totalTimeoutMs: options.totalTimeoutMs,
    retries: options.retries,
    retryDelayMs: options.retryDelayMs,
    signal: options.signal,
  })

  if (!result.ok) {
    const failure = result.failure
    const message =
      failure.kind === 'aborted'
        ? '诊断已取消'
        : failure.kind === 'timeout'
          ? '模型响应超时'
          : failure.kind === 'http'
            ? `模型请求失败（HTTP ${failure.status}）`
            : `模型请求异常：${failure.reason}`
    return fail(failure.kind === 'aborted' ? 'aborted' : 'analysis-failed', message, {
      kind: failure.kind,
      ...(failure.kind === 'http' ? { status: failure.status } : {}),
      ...(failure.kind === 'timeout' && failure.budgetExhausted ? { budgetExhausted: true } : {}),
    })
  }

  const reply = parseReply(result.text)
  if (!reply) return fail('analysis-failed', '模型响应无法解析')
  return ok(reply)
}
