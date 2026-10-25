/** 智能体相关测试共用的夹具：两条样例轨迹、工具上下文、按序回放的假模型。
 *  仅供测试文件导入，生产代码不得引用（`pnpm check:layers` 会检查）。 */

import { analyze, type SessionAnalysis } from '../analysis'
import { DEFAULT_PACK } from '../rules/builtin-pack'
import type { LlmRequest, LlmTransport } from '../llm/transport'
import type { ToolContext } from './types'

export const BAD_TRACE = [
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '查一下报销标准' },
  {
    role: 'assistant',
    tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{bad json' } }],
  },
  { role: 'tool', tool_call_id: 'c1', content: 'Error: timeout' },
  { role: 'assistant', content: '抱歉，没查到。' },
]

export const GOOD_TRACE = [
  { role: 'user', content: '查一下报销标准' },
  { role: 'assistant', content: '住宿上限 500 元，依据财务制度第 3 条。' },
]

export function contextWith(source: unknown = [BAD_TRACE, GOOD_TRACE]): ToolContext {
  const analyzed = analyze({ source: JSON.stringify(source), label: 'traces.json' })
  if (!analyzed.ok) throw new Error(analyzed.error.message)
  return { sessions: analyzed.value.sessions, pack: DEFAULT_PACK, annotations: [] }
}

export function first(context: ToolContext): SessionAnalysis {
  const session = context.sessions[0]
  if (!session) throw new Error('fixture has no session')
  return session
}

export interface Turn {
  content?: string
  calls?: { name: string; args?: unknown; raw?: string; id?: string }[]
}

/** 把一回合写成 OpenAI 形状：测试里只要关心「模型说了什么、要调什么」。 */
export function turn(input: Turn): string {
  return JSON.stringify({
    choices: [
      {
        message: {
          content: input.content ?? '',
          ...(input.calls
            ? {
                tool_calls: input.calls.map((call, index) => ({
                  id: call.id ?? `call_${index}`,
                  type: 'function',
                  function: {
                    name: call.name,
                    arguments: call.raw ?? JSON.stringify(call.args ?? {}),
                  },
                })),
              }
            : {}),
        },
        finish_reason: input.calls ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  })
}

/** 按序回放；用完之后重复最后一回合，正好用来演「永不收尾」。 */
export function scripted(turns: string[]): { transport: LlmTransport; requests: LlmRequest[] } {
  const requests: LlmRequest[] = []
  let index = 0
  const transport: LlmTransport = async (request) => {
    requests.push(request)
    const text = turns[Math.min(index, turns.length - 1)] ?? turn({ content: '' })
    index += 1
    return { ok: true, status: 200, text }
  }
  return { transport, requests }
}

export const BASE = {
  url: 'https://llm.test/v1/chat/completions',
  model: 'test-model',
  apiKey: 'secret-key',
  locale: 'zh-CN' as const,
  retryDelayMs: 0,
}
