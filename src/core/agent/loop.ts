/** 诊断循环：模型 → 工具 → 回灌 → 再模型，直到收尾或预算耗尽。
 *
 *  三条边界写在这里，而不是靠提示词祈祷：
 *  - **预算硬上限**：轮次、工具调用数、墙钟。超了就停下并**如实标注未收敛**，
 *    不假装那是一次完整诊断。
 *  - **工具失败不终止循环**：错误作为 tool 消息回灌，模型有机会自己纠正。
 *    只有端点级失败才终止——那是它无法修复的。
 *  - **失败也保留 trace**：`AgentRun` 不用 `Result` 包装，因为"为什么没得出结论"
 *    恰恰要靠 trace 回答，折成 `{ ok: false }` 等于把唯一证据丢掉。
 */

import type { AppError } from '../model'
import type { LlmTransport } from '../llm/transport'
import type { Locale } from '../../i18n/core'
import { chat } from './chat'
import { buildAgentMessages } from './prompt'
import { parseDiagnosis, toolByName, toolSpecs } from './tools'
import { AGENT_BUDGET } from './types'
import type {
  AgentBudget,
  AgentMessage,
  AgentRun,
  AgentTrace,
  Diagnosis,
  ToolContext,
  ToolOutcome,
} from './types'

export interface AgentOptions {
  transport: LlmTransport
  url: string
  model: string
  apiKey: string
  locale: Locale
  budget?: Partial<AgentBudget>
  /** 用户自定义任务；不传则用默认诊断任务。 */
  task?: string
  signal?: AbortSignal
  /** 注入时钟：测试靠它把「墙钟耗尽」这条路走通，不必真等。 */
  now?: () => number
  /** 重试间隔：测试置 0，免得为一个 500 真等 800ms。 */
  retryDelayMs?: number
}

/** 参数不是合法 JSON 时保留原文回灌：模型能看见自己写坏了什么，
 *  比我们替它猜一个「{}」有用。 */
function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function missingTool(name: string): ToolOutcome {
  return {
    ok: false,
    content: JSON.stringify({
      error: `没有这个工具：${name}`,
      available: toolSpecs().map((spec) => spec.name),
    }),
  }
}

function badArgs(raw: string): ToolOutcome {
  return {
    ok: false,
    content: JSON.stringify({
      error: 'arguments 不是合法的 JSON 对象',
      received: raw.slice(0, 200),
    }),
  }
}

export async function runAgent(context: ToolContext, options: AgentOptions): Promise<AgentRun> {
  const budget: AgentBudget = { ...AGENT_BUDGET, ...options.budget }
  const now = options.now ?? (() => Date.now())
  const started = now()

  const trace: AgentTrace = {
    entries: [],
    rounds: 0,
    toolCalls: 0,
    truncated: false,
    stopReason: 'answered',
  }
  const usage = { prompt: 0, completion: 0 }

  const messages: AgentMessage[] = buildAgentMessages({
    locale: options.locale,
    packName: context.pack.name,
    sessionCount: context.sessions.length,
    task: options.task,
  })

  let diagnosis: Diagnosis | null = null
  let answer = ''
  let error: AppError | undefined
  /** 每轮模型的文本：没走到收尾时，它是「未完成的草稿」，丢掉不如留着。 */
  let lastText = ''

  const done = (): AgentRun => ({
    ok: error === undefined,
    error: error ? { code: error.code, message: error.message } : undefined,
    diagnosis,
    // 撞预算而停时，模型很可能已经写了判断。把它交出去并保留 truncated 标记，
    // 读者看得到「这是未完稿」——比显示「模型没有给出结论」有用得多。
    answer: answer === '' && trace.truncated ? lastText : answer,
    trace,
    usage,
  })

  for (let round = 1; round <= budget.maxRounds; round += 1) {
    if (options.signal?.aborted) {
      error = { code: 'aborted', message: '诊断已取消' }
      return done()
    }
    if (now() - started > budget.maxDurationMs) {
      trace.truncated = true
      trace.stopReason = 'duration'
      return done()
    }

    const sentAt = now()
    const reply = await chat(messages, {
      transport: options.transport,
      url: options.url,
      model: options.model,
      apiKey: options.apiKey,
      maxTokens: budget.maxTokens,
      timeoutMs: budget.timeoutMs,
      retryDelayMs: options.retryDelayMs,
      tools: toolSpecs(),
      signal: options.signal,
    })
    trace.rounds = round

    if (!reply.ok) {
      // 端点级失败：这一轮什么都没发生，继续循环只会重复烧配额。
      error = reply.error
      return done()
    }

    const turn = reply.value
    if (turn.content.trim() !== '') lastText = turn.content
    usage.prompt += turn.usage.prompt
    usage.completion += turn.usage.completion
    trace.entries.push({
      kind: 'model',
      round,
      content: turn.content,
      toolCalls: turn.toolCalls.length,
      reasoningChars: turn.reasoningChars,
      ms: now() - sentAt,
    })

    if (turn.toolCalls.length === 0) {
      answer = turn.content
      // 既没有文本也没有调用 = 模型什么都没说。算收尾，但要标出来。
      if (answer.trim() === '') trace.truncated = true
      trace.stopReason = 'answered'
      return done()
    }

    messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls })

    let halted = false
    for (const call of turn.toolCalls) {
      if (trace.toolCalls >= budget.maxToolCalls) {
        trace.truncated = true
        trace.stopReason = 'tool-calls'
        halted = true
        break
      }

      const tool = toolByName(call.name)
      const args = parseArgs(call.arguments)
      const toolStarted = now()

      let outcome: ToolOutcome
      if (!tool) {
        outcome = missingTool(call.name)
      } else if (args === null) {
        outcome = badArgs(call.arguments)
      } else {
        try {
          outcome = tool.run(args, context)
        } catch (thrown) {
          // 工具的意外异常同样只影响这一次调用：模型能换条路走。
          outcome = {
            ok: false,
            content: JSON.stringify({
              error: '工具执行异常',
              reason: thrown instanceof Error ? thrown.message : String(thrown),
            }),
          }
        }
      }

      trace.toolCalls += 1
      trace.entries.push({
        kind: 'tool',
        round,
        name: call.name,
        args: call.arguments,
        ok: outcome.ok,
        result: outcome.content,
        ms: now() - toolStarted,
      })
      messages.push({ role: 'tool', content: outcome.content, toolCallId: call.id })

      // 终结工具被拒绝（比如 verdict 为空）时不结束：让模型自己补参数。
      if (tool?.terminal && outcome.ok && args) {
        diagnosis = parseDiagnosis(args)
        answer = diagnosis?.verdict ?? ''
        trace.stopReason = 'submitted'
        halted = true
        break
      }
    }

    if (halted) return done()

    if (round === budget.maxRounds) {
      // 撞到轮次上限还没收尾：结论不完整，报告必须如实说。
      trace.truncated = true
      trace.stopReason = 'rounds'
    }
  }

  return done()
}
