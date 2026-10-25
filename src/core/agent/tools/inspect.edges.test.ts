import { describe, expect, it } from 'vitest'
import { DEFAULT_PACK } from '../../rules/builtin-pack'
import { analyzeSessions } from '../../test-support'
import type { ToolContext } from '../types'
import { toolByName } from './index'

// 会话查看类工具的参数边界。模型会传各种不规整的参数（0、字符串形式的数字、缺字段），
// 这里锁住的是「每种情况下它拿到什么」：是被夹到合法范围，还是被明确拒绝并告知原因。

const BAD_TRACE = [
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '查一下报销标准' },
  { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{bad json' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'Error: Timeout while calling search' },
  { role: 'assistant', content: '抱歉，没查到。' },
]

const GOOD_TRACE = [
  { role: 'user', content: '查一下报销标准' },
  { role: 'assistant', content: '住宿上限 500 元，依据财务制度第 3 条。' },
]

function contextOf(...traces: unknown[][]): ToolContext {
  const sessions = analyzeSessions(JSON.stringify(traces))
  return { sessions, pack: DEFAULT_PACK, annotations: [] }
}

interface Outcome {
  ok: boolean
  payload: Record<string, unknown>
}

function call(name: string, args: Record<string, unknown>, context: ToolContext): Outcome {
  const tool = toolByName(name)
  if (!tool) throw new Error(`no tool ${name}`)
  const outcome = tool.run(args, context) as { ok: boolean; content: string }
  return { ok: outcome.ok, payload: JSON.parse(outcome.content) as Record<string, unknown> }
}

function idOf(context: ToolContext, index = 0): string {
  const session = context.sessions[index]
  if (!session) throw new Error('fixture has no such session')
  return session.id
}

/** n 条 user/assistant 交替的消息，每条文本都含 marker，便于按步数控制命中。 */
function longTrace(count: number, text: (index: number) => string): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: text(index),
  }))
}

/** 一条会话里有 count 次参数无法解析的工具调用，每次都会命中一条结构错误。 */
function manyBadCalls(count: number): unknown[] {
  return [
    { role: 'user', content: '查一下' },
    ...Array.from({ length: count }, (_, index) => ({
      role: 'assistant',
      tool_calls: [{ id: `c${index}`, function: { name: 'search', arguments: '{bad' } }],
    })),
  ]
}

describe('list_sessions', () => {
  it('says so when there is nothing to list, instead of returning an empty overview', () => {
    const result = call('list_sessions', {}, { sessions: [], pack: DEFAULT_PACK, annotations: [] })
    expect(result.ok).toBe(false)
    expect(result.payload.error).toContain('没有可分析的会话')
  })
})

describe('get_card', () => {
  it('reports the dimensions and the findings that cost the most', () => {
    const context = contextOf(BAD_TRACE)
    const { ok, payload } = call('get_card', { sessionId: idOf(context) }, context)
    expect(ok).toBe(true)
    expect(payload.dimensions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'structure' })]))
    expect((payload.topFindings as unknown[]).length).toBeGreaterThan(0)
  })

  it('names the ids that do exist when the id is wrong or missing', () => {
    const context = contextOf(BAD_TRACE, GOOD_TRACE)
    for (const args of [{ sessionId: 'nope' }, {}]) {
      const { ok, payload } = call('get_card', args, context)
      expect(ok).toBe(false)
      expect(payload.available).toEqual(context.sessions.map((session) => session.id))
    }
  })
})

describe('get_findings', () => {
  it('raises a limit below 1 to 1 and accepts a number written as a string', () => {
    const context = contextOf(BAD_TRACE)
    const id = idOf(context)
    const total = call('get_findings', { sessionId: id }, context).payload.total as number
    expect(total).toBeGreaterThan(1)

    expect(call('get_findings', { sessionId: id, limit: 0 }, context).payload.returned).toBe(1)
    expect(call('get_findings', { sessionId: id, limit: -5 }, context).payload.returned).toBe(1)
    expect(call('get_findings', { sessionId: id, limit: '2' }, context).payload.returned).toBe(2)
  })

  it('returns twenty by default, and an oversized request comes back as a truncated envelope', () => {
    const context = contextOf(manyBadCalls(60))
    const id = idOf(context)

    const byDefault = call('get_findings', { sessionId: id }, context).payload
    expect(byDefault.total as number).toBeGreaterThan(50) // 前提：夹具确实产生了足够多的问题
    expect(byDefault.returned).toBe(20)

    // 说明里写的上限是 50，但每条问题带着消息和证据，二十几条就超过单次结果的 4000 字上限，
    // 所以大的 limit 实际拿到的是「被截断」的外壳，模型要据此缩小范围重试。
    const big = call('get_findings', { sessionId: id, limit: 999 }, context).payload
    expect(big.truncated).toBe(true)
    expect(big.note).toContain('请缩小范围')
    expect(big.returned).toBeUndefined()
  })

  it('filters by dimension, and ignores a severity it does not recognise instead of returning nothing', () => {
    const context = contextOf(BAD_TRACE)
    const id = idOf(context)
    const all = call('get_findings', { sessionId: id }, context).payload.total as number

    const structure = call('get_findings', { sessionId: id, dimension: 'structure' }, context)
    const findings = structure.payload.findings as { dimension: string }[]
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.every((finding) => finding.dimension === 'structure')).toBe(true)

    expect(call('get_findings', { sessionId: id, severity: 'bogus' }, context).payload.total).toBe(all)
    expect(
      call('get_findings', { sessionId: id, dimension: 'no-such-dimension' }, context).payload.total,
    ).toBe(0)
  })
})

describe('read_steps', () => {
  const context = contextOf(longTrace(30, (index) => `message ${index + 1}`))
  const id = idOf(context)

  it('reads ten steps from the start when no range is given', () => {
    const { payload } = call('read_steps', { sessionId: id }, context)
    expect(payload).toMatchObject({ from: 1, to: 10, steps: 30 })
  })

  it('treats a start below 1 as 1', () => {
    expect(call('read_steps', { sessionId: id, from: 0, to: 3 }, context).payload).toMatchObject({
      from: 1,
      to: 3,
    })
  })

  it('cuts the range at the last step, and reports the range it actually returned', () => {
    expect(call('read_steps', { sessionId: id, from: 28, to: 35 }, context).payload).toMatchObject({
      from: 28,
      to: 30,
    })
  })

  it('rejects a reversed range and one that starts past the end', () => {
    const reversed = call('read_steps', { sessionId: id, from: 5, to: 2 }, context)
    expect(reversed.ok).toBe(false)
    expect(reversed.payload.error).toContain('to 不能小于 from')

    const beyond = call('read_steps', { sessionId: id, from: 31, to: 33 }, context)
    expect(beyond.ok).toBe(false)
    expect(beyond.payload).toMatchObject({ error: '区间超出范围', steps: 30 })
  })

  it('allows exactly 40 steps and refuses 41', () => {
    const long = contextOf(longTrace(60, (index) => `m${index}`))
    const longId = idOf(long)
    expect(call('read_steps', { sessionId: longId, from: 1, to: 40 }, long).ok).toBe(true)
    expect(call('read_steps', { sessionId: longId, from: 1, to: 41 }, long).ok).toBe(false)
  })

  it('names the ids that do exist when the id is wrong', () => {
    const { ok, payload } = call('read_steps', { sessionId: 'nope' }, context)
    expect(ok).toBe(false)
    expect(payload.available).toEqual([id])
  })
})

describe('get_step', () => {
  it('asks for a step number when none is given, and rejects one that does not exist', () => {
    const context = contextOf(GOOD_TRACE)
    const id = idOf(context)
    expect(call('get_step', { sessionId: id }, context).payload.error).toContain('需要 step')
    expect(call('get_step', { sessionId: id, step: 'abc' }, context).ok).toBe(false)
    for (const step of [0, -1, 3]) {
      const result = call('get_step', { sessionId: id, step }, context)
      expect(result.ok, `step ${step}`).toBe(false)
      expect(result.payload).toMatchObject({ error: '步号超出范围', steps: 2, given: step })
    }
  })

  it('returns tool calls with their results, and the findings that landed on this step', () => {
    const context = contextOf(BAD_TRACE)
    const id = idOf(context)
    const { ok, payload } = call('get_step', { sessionId: id, step: 3 }, context)
    expect(ok).toBe(true)
    expect(payload).toMatchObject({ step: 3, role: 'assistant' })
    const calls = payload.toolCalls as {
      name: string
      argsValid: boolean
      result: { isError: boolean } | null
    }[]
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ name: 'search', argsValid: false })
    expect(calls[0]?.result?.isError).toBe(true)
    expect((payload.findings as { step: number }[]).every((finding) => finding.step === 3)).toBe(true)
    expect((payload.findings as unknown[]).length).toBeGreaterThan(0)
  })

  it('shortens a very long text and says it was cut with an ellipsis', () => {
    const context = contextOf([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'x'.repeat(5000) },
    ])
    const { payload } = call('get_step', { sessionId: idOf(context), step: 2 }, context)
    const text = payload.text as string
    expect(text).toHaveLength(1501)
    expect(text.endsWith('…')).toBe(true)
  })
})

describe('search_steps', () => {
  const context = contextOf(longTrace(20, (index) => `Step ${index + 1} mentions the NEEDLE here`))
  const id = idOf(context)

  it('needs a query', () => {
    for (const query of [undefined, '', '   ']) {
      const result = call('search_steps', { sessionId: id, query }, context)
      expect(result.ok, JSON.stringify(query)).toBe(false)
      expect(result.payload.error).toContain('需要 query')
    }
  })

  it('matches regardless of case and returns 1-based step numbers', () => {
    const { payload } = call('search_steps', { sessionId: id, query: 'needle', limit: 2 }, context)
    const hits = payload.hits as { step: number; snippet: string }[]
    expect(hits.map((hit) => hit.step)).toEqual([1, 2])
    expect(hits[0]?.snippet).toContain('NEEDLE')
  })

  it('matches regardless of the case of the query, too', () => {
    const lowerText = contextOf(longTrace(4, () => 'only lower case needle here'))
    const { payload } = call('search_steps', { sessionId: idOf(lowerText), query: 'NEEDLE' }, lowerText)
    expect((payload.hits as unknown[]).length).toBe(4)
  })

  it('also looks inside tool results, on the step that made the call and on the result step', () => {
    const toolContext = contextOf(BAD_TRACE)
    const { payload } = call(
      'search_steps',
      { sessionId: idOf(toolContext), query: 'timeout while' },
      toolContext,
    )
    // 第 4 步是工具消息本体；第 3 步的调用配对到了这条结果，所以也命中
    expect((payload.hits as { step: number }[]).map((hit) => hit.step)).toEqual([3, 4])
  })

  it('stops at the limit and flags that there may be more', () => {
    const capped = call('search_steps', { sessionId: id, query: 'needle', limit: 3 }, context).payload
    expect((capped.hits as unknown[]).length).toBe(3)
    expect(capped.truncated).toBe(true)

    const everything = call('search_steps', { sessionId: id, query: 'needle', limit: 30 }, context).payload
    expect((everything.hits as unknown[]).length).toBe(20)
    expect(everything.truncated).toBe(false)
  })

  it('defaults to ten hits and never returns more than thirty', () => {
    const many = contextOf(longTrace(50, () => 'needle'))
    const manyId = idOf(many)
    expect(
      (call('search_steps', { sessionId: manyId, query: 'needle' }, many).payload.hits as unknown[]).length,
    ).toBe(10)
    expect(
      (
        call('search_steps', { sessionId: manyId, query: 'needle', limit: 500 }, many).payload
          .hits as unknown[]
      ).length,
    ).toBe(30)
  })

  it('reports no hits without flagging truncation', () => {
    const { payload } = call('search_steps', { sessionId: id, query: 'absent-term' }, context)
    expect(payload).toMatchObject({ hits: [], truncated: false })
  })

  it('cuts the snippet to a window around the match', () => {
    const padded = contextOf([
      { role: 'user', content: `${'a'.repeat(200)}TARGET${'b'.repeat(200)}` },
      { role: 'assistant', content: 'ok' },
    ])
    const { payload } = call('search_steps', { sessionId: idOf(padded), query: 'target' }, padded)
    const snippet = (payload.hits as { snippet: string }[])[0]?.snippet ?? ''
    expect(snippet).toContain('TARGET')
    expect(snippet.length).toBeLessThan(140)
  })
})

describe('compare_sessions', () => {
  const context = contextOf(BAD_TRACE, GOOD_TRACE)
  const [baseId, targetId] = [idOf(context, 0), idOf(context, 1)]

  it('names the ids that do exist when either side is unknown', () => {
    for (const args of [
      { baseId: 'nope', targetId },
      { baseId, targetId: 'nope' },
      { baseId, targetId: undefined },
    ]) {
      const { ok, payload } = call('compare_sessions', args, context)
      expect(ok).toBe(false)
      expect(payload.available).toEqual([baseId, targetId])
    }
  })

  it('refuses to compare a session with itself', () => {
    const { ok, payload } = call('compare_sessions', { baseId, targetId: baseId }, context)
    expect(ok).toBe(false)
    expect(payload.error).toContain('不能是同一条会话')
  })

  it('reports the score change and which findings were fixed or introduced', () => {
    const { ok, payload } = call('compare_sessions', { baseId, targetId }, context)
    expect(ok).toBe(true)
    expect(payload.base).toMatchObject({ id: baseId })
    expect(payload.target).toMatchObject({ id: targetId })
    // 坏轨迹 → 好轨迹：error 与 warn 都修复了；好轨迹没有 system 提示词也没调工具，只多出两条 info
    const ruleIds = (list: unknown) => (list as { ruleId: string }[]).map((finding) => finding.ruleId).sort()
    expect(ruleIds(payload.resolved)).toEqual([
      'exec-error-rate',
      'exec-tool-error',
      'structure-invalid-args',
    ])
    expect(ruleIds(payload.added)).toEqual(['eff-no-tools', 'structure-no-system'])
    expect((payload.added as { severity: string }[]).every((finding) => finding.severity === 'info')).toBe(
      true,
    )
    expect(payload.persisted).toBe(0)
    expect(payload.netChange).toBe(-1)
  })
})

describe('oversized results', () => {
  it('stay valid JSON and tell the model the result was cut', () => {
    // 40 步、每步约 400 字，序列化后远超单个结果的上限
    const context = contextOf(longTrace(45, (index) => `${index} ${'long text '.repeat(40)}`))
    const result = toolByName('read_steps')?.run({ sessionId: idOf(context), from: 1, to: 40 }, context)
    expect(result?.ok).toBe(true)
    const payload = JSON.parse(result?.content ?? '') as {
      truncated?: boolean
      note?: string
      preview?: string
    }
    expect(payload.truncated).toBe(true)
    expect(payload.note).toContain('请缩小范围')
    expect(payload.preview?.length).toBe(4000)
  })
})
