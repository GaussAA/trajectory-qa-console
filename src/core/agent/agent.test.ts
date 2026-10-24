import { describe, expect, it, vi } from 'vitest'
import { analyze, scoreSession, type SessionAnalysis } from '../analysis'
import { DEFAULT_PACK } from '../rules/builtin-pack'
import type { LlmRequest, LlmTransport } from '../llm/transport'
import { parseReply } from './chat'
import { runAgent } from './loop'
import { parseDiagnosis, TOOLS, toolByName, toolSpecs } from './tools'
import type { PackProposal, ToolContext } from './types'

// ---------- fixtures ----------

const BAD_TRACE = [
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '查一下报销标准' },
  {
    role: 'assistant',
    tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{bad json' } }],
  },
  { role: 'tool', tool_call_id: 'c1', content: 'Error: timeout' },
  { role: 'assistant', content: '抱歉，没查到。' },
]

const GOOD_TRACE = [
  { role: 'user', content: '查一下报销标准' },
  { role: 'assistant', content: '住宿上限 500 元，依据财务制度第 3 条。' },
]

function contextWith(source: unknown = [BAD_TRACE, GOOD_TRACE]): ToolContext {
  const analyzed = analyze({ source: JSON.stringify(source), label: 'traces.json' })
  if (!analyzed.ok) throw new Error(analyzed.error.message)
  return { sessions: analyzed.value.sessions, pack: DEFAULT_PACK, annotations: [] }
}

function first(context: ToolContext): SessionAnalysis {
  const session = context.sessions[0]
  if (!session) throw new Error('fixture has no session')
  return session
}

interface Turn {
  content?: string
  calls?: { name: string; args?: unknown; raw?: string; id?: string }[]
}

/** 把一回合写成 OpenAI 形状：测试里只要关心「模型说了什么、要调什么」。 */
function turn(input: Turn): string {
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
function scripted(turns: string[]): { transport: LlmTransport; requests: LlmRequest[] } {
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

const BASE = {
  url: 'https://llm.test/v1/chat/completions',
  model: 'test-model',
  apiKey: 'secret-key',
  locale: 'zh-CN' as const,
  retryDelayMs: 0,
}

// ---------- parseReply ----------

describe('parseReply', () => {
  it('tolerates object arguments and missing call ids', () => {
    const reply = parseReply(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                { function: { name: 'a', arguments: { x: 1 } } },
                { id: 'b', function: { name: 'b', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }),
    )
    expect(reply?.toolCalls).toEqual([
      { id: 'call_0', name: 'a', arguments: '{"x":1}' },
      { id: 'b', name: 'b', arguments: '{}' },
    ])
    expect(reply?.usage).toEqual({ prompt: 3, completion: 4 })
    expect(reply?.finishReason).toBe('tool_calls')
  })

  it('accepts a proxy that returns plain text', () => {
    expect(parseReply('就直接说一句话')).toMatchObject({ content: '就直接说一句话', toolCalls: [] })
  })

  it('returns null when nothing readable comes back', () => {
    expect(parseReply('')).toBeNull()
    expect(parseReply('{}')).toBeNull()
  })
})

// ---------- loop ----------

describe('runAgent', () => {
  it('converges on submit_diagnosis and records every tool call', async () => {
    const { transport } = scripted([
      turn({ calls: [{ name: 'list_sessions' }] }),
      turn({
        calls: [
          {
            name: 'submit_diagnosis',
            args: {
              verdict: '整体可用，短板在工具错误处理',
              rootCauses: [{ session: 'x', cause: '工具报错后直接放弃', evidence: '第 4 步' }],
              actions: [{ action: '提高 exec-tool-error 的扣分', ruleId: 'exec-tool-error' }],
            },
          },
        ],
      }),
    ])

    const run = await runAgent(contextWith(), { ...BASE, transport })

    expect(run.ok).toBe(true)
    expect(run.trace.stopReason).toBe('submitted')
    expect(run.trace.truncated).toBe(false)
    expect(run.trace.rounds).toBe(2)
    expect(run.trace.toolCalls).toBe(2)
    expect(run.diagnosis?.verdict).toContain('工具错误处理')
    expect(run.diagnosis?.actions[0]?.ruleId).toBe('exec-tool-error')
    expect(run.usage.prompt).toBe(20)
  })

  it('accepts a plain-text answer without a terminal tool', async () => {
    const { transport } = scripted([turn({ content: '这批轨迹都还可以。' })])
    const run = await runAgent(contextWith(), { ...BASE, transport })

    expect(run.ok).toBe(true)
    expect(run.trace.stopReason).toBe('answered')
    expect(run.answer).toBe('这批轨迹都还可以。')
    expect(run.trace.toolCalls).toBe(0)
  })

  it('stops at the round limit and says so', async () => {
    const { transport } = scripted([turn({ calls: [{ name: 'list_sessions' }] })])
    const run = await runAgent(contextWith(), { ...BASE, transport, budget: { maxRounds: 2 } })

    expect(run.ok).toBe(true)
    expect(run.trace.truncated).toBe(true)
    expect(run.trace.stopReason).toBe('rounds')
    expect(run.trace.rounds).toBe(2)
  })

  it('keeps the draft the model wrote before it ran out of rounds', async () => {
    const { transport } = scripted([
      turn({ content: '初步看，工具报错是主因。', calls: [{ name: 'list_sessions' }] }),
    ])
    const run = await runAgent(contextWith(), { ...BASE, transport, budget: { maxRounds: 2 } })

    expect(run.trace.truncated).toBe(true)
    // 草稿要交出来，但 truncated 标记不变——读者知道这是未完稿。
    expect(run.answer).toContain('工具报错')
  })

  it('stops at the tool-call limit mid-turn', async () => {
    const { transport } = scripted([
      turn({ calls: [{ name: 'list_sessions' }, { name: 'list_sessions' }, { name: 'list_sessions' }] }),
    ])
    const run = await runAgent(contextWith(), { ...BASE, transport, budget: { maxToolCalls: 2 } })

    expect(run.trace.truncated).toBe(true)
    expect(run.trace.stopReason).toBe('tool-calls')
    // 超限那次不该被执行：2 次调用就停，不是 3 次。
    expect(run.trace.toolCalls).toBe(2)
  })

  it('feeds an unknown tool back instead of dying', async () => {
    const { transport } = scripted([
      turn({ calls: [{ name: 'delete_everything' }] }),
      turn({ content: '好，我改用 list_sessions。' }),
    ])
    const run = await runAgent(contextWith(), { ...BASE, transport })

    const failed = run.trace.entries.find((entry) => entry.kind === 'tool')
    expect(failed && failed.kind === 'tool' ? failed.ok : true).toBe(false)
    expect(run.ok).toBe(true)
    // 错误被回灌，模型下一轮还有机会——循环没有因此终止。
    expect(run.trace.rounds).toBe(2)
  })

  it('feeds malformed arguments back', async () => {
    const { transport } = scripted([
      turn({ calls: [{ name: 'get_card', raw: '{"sessionId":' }] }),
      turn({ content: '参数写坏了，我重来。' }),
    ])
    const run = await runAgent(contextWith(), { ...BASE, transport })
    const entry = run.trace.entries.find((item) => item.kind === 'tool')
    expect(entry && entry.kind === 'tool' ? entry.result : '').toContain('arguments')
    expect(run.ok).toBe(true)
  })

  it('survives a throwing tool', async () => {
    const first = TOOLS[0]
    if (!first) throw new Error('no tools registered')
    const spy = vi.spyOn(first, 'run').mockImplementation(() => {
      throw new Error('boom')
    })
    try {
      const { transport } = scripted([
        turn({ calls: [{ name: first.spec.name }] }),
        turn({ content: '工具自己崩了，我换个思路。' }),
      ])
      const run = await runAgent(contextWith(), { ...BASE, transport })
      const entry = run.trace.entries.find((item) => item.kind === 'tool')
      expect(entry && entry.kind === 'tool' ? entry.result : '').toContain('boom')
      expect(run.ok).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps going when the terminal tool is rejected', async () => {
    const { transport } = scripted([
      // verdict 为空 = 工具拒绝，循环不该在这里结束
      turn({ calls: [{ name: 'submit_diagnosis', args: {} }] }),
      turn({ calls: [{ name: 'submit_diagnosis', args: { verdict: '补上了' } }] }),
    ])
    const run = await runAgent(contextWith(), { ...BASE, transport })

    expect(run.trace.stopReason).toBe('submitted')
    expect(run.diagnosis?.verdict).toBe('补上了')
    expect(run.trace.toolCalls).toBe(2)
  })

  it('stops on an endpoint failure but keeps the trace', async () => {
    const transport: LlmTransport = async () => ({ ok: false, status: 500, text: 'upstream down' })
    const run = await runAgent(contextWith(), { ...BASE, transport })

    expect(run.ok).toBe(false)
    expect(run.error?.message).toContain('500')
    expect(run.trace.rounds).toBe(1)
  })

  it('does not call the model once aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { transport, requests } = scripted([turn({ content: 'never' })])
    const run = await runAgent(contextWith(), { ...BASE, transport, signal: controller.signal })

    expect(run.ok).toBe(false)
    expect(run.error?.code).toBe('aborted')
    expect(requests).toHaveLength(0)
  })

  it('stops when the wall clock budget is gone', async () => {
    // started = 0 → 第一轮检查 0（继续）→ 之后所有时刻都远超上限
    const times = [0, 0]
    let calls = 0
    const run = await runAgent(contextWith(), {
      ...BASE,
      transport: scripted([turn({ calls: [{ name: 'list_sessions' }] })]).transport,
      budget: { maxDurationMs: 100 },
      now: () => {
        calls += 1
        return times.length > 0 ? (times.shift() as number) : 999_999
      },
    })

    expect(calls).toBeGreaterThan(2)
    expect(run.trace.truncated).toBe(true)
    expect(run.trace.stopReason).toBe('duration')
  })

  it('does not let one hung call outlive the wall clock budget', async () => {
    // 单次超时 5s、总时长 300ms：钳制前这里要挂满 5s（还会被重试），钳制后约 300ms 就收尾。
    const hang: LlmTransport = () => new Promise(() => undefined)
    const started = Date.now()
    const run = await runAgent(contextWith(), {
      ...BASE,
      transport: hang,
      budget: { maxDurationMs: 300, timeoutMs: 5000 },
    })

    expect(Date.now() - started).toBeLessThan(2000)
    // 撞的是总时长上限，不是端点故障：按「未收敛」如实交代，而不是报一个错
    expect(run.ok).toBe(true)
    expect(run.trace.truncated).toBe(true)
    expect(run.trace.stopReason).toBe('duration')
  })

  it('still reports a genuine per-call timeout as an error when the budget is not the cause', async () => {
    const hang: LlmTransport = () => new Promise(() => undefined)
    const run = await runAgent(contextWith(), {
      ...BASE,
      transport: hang,
      budget: { maxDurationMs: 60_000, timeoutMs: 40 },
    })

    expect(run.ok).toBe(false)
    expect(run.error?.message).toContain('超时')
    expect(run.trace.stopReason).not.toBe('duration')
  })

  it('flags an answer that was cut off by the output limit instead of calling it finished', async () => {
    const cutOff = JSON.stringify({
      choices: [{ message: { content: '根因有三点：第一，工具参数' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 4096 },
    })
    const run = await runAgent(contextWith(), { ...BASE, transport: scripted([cutOff]).transport })

    expect(run.trace.truncated).toBe(true)
    expect(run.trace.stopReason).toBe('output-limit')
    // 半截的话仍然交出去，让读者看到它是未完稿，而不是丢掉
    expect(run.answer).toContain('根因有三点')
  })

  it('does not flag a normal answer that stopped by itself', async () => {
    const run = await runAgent(contextWith(), {
      ...BASE,
      transport: scripted([turn({ content: '一切正常。' })]).transport,
    })

    expect(run.trace.truncated).toBe(false)
    expect(run.trace.stopReason).toBe('answered')
  })

  it('collects proposals into the run without touching the caller context', async () => {
    const { transport } = scripted([
      turn({
        calls: [
          {
            name: 'propose_pack',
            args: { rationale: '执行维扣分偏轻', edits: [{ ruleId: 'exec-dead-loop', scoreImpact: 30 }] },
          },
        ],
      }),
      turn({ content: '提案已提交。' }),
    ])

    const context = contextWith()
    const run = await runAgent(context, { ...BASE, transport })

    expect(run.proposals).toHaveLength(1)
    expect(run.proposals[0]?.id).toBe('p1')
    // 收集器挂在本次运行自己的上下文上，调用方传进来的对象不该被塞东西。
    expect(context.proposals).toBeUndefined()
  })

  it('never leaks the api key into a failure', async () => {
    const transport: LlmTransport = async () => ({ ok: false, status: 401, text: 'bad key' })
    const run = await runAgent(contextWith(), { ...BASE, transport })
    expect(JSON.stringify(run)).not.toContain('secret-key')
  })
})

// ---------- tools ----------

describe('tools', () => {
  it('registers every tool with a callable name and a schema', () => {
    for (const spec of toolSpecs()) {
      expect(spec.name).toMatch(/^[a-z_]+$/)
      expect(spec.description.length).toBeGreaterThan(10)
      expect(spec.parameters.type).toBe('object')
      expect(toolByName(spec.name)).toBeDefined()
    }
    expect(toolByName('nope')).toBeUndefined()
  })

  it('list_sessions reports the same scores as the main path', () => {
    const context = contextWith()
    const outcome = toolByName('list_sessions')?.run({}, context)
    const payload = JSON.parse(outcome?.content ?? '{}') as {
      sessions: { id: string; overall: number }[]
    }
    const session = first(context)
    expect(payload.sessions[0]?.overall).toBe(scoreSession(session, DEFAULT_PACK, []).overall)
  })

  it('rejects unknown session ids but lists the ones that exist', () => {
    const context = contextWith()
    const outcome = toolByName('get_card')?.run({ sessionId: 'nope' }, context)
    expect(outcome?.ok).toBe(false)
    expect(outcome?.content).toContain('available')
  })

  it('filters findings by severity', () => {
    const context = contextWith()
    const outcome = toolByName('get_findings')?.run(
      { sessionId: first(context).id, severity: 'error' },
      context,
    )
    const payload = JSON.parse(outcome?.content ?? '{}') as { findings: { severity: string }[] }
    expect(payload.findings.every((item) => item.severity === 'error')).toBe(true)
  })

  it('refuses to dump more than 40 steps at once', () => {
    const context = contextWith()
    const outcome = toolByName('read_steps')?.run({ sessionId: first(context).id, from: 1, to: 60 }, context)
    expect(outcome?.ok).toBe(false)
  })

  it('renders a step range with 1-based numbers', () => {
    const context = contextWith()
    const outcome = toolByName('read_steps')?.run({ sessionId: first(context).id, from: 2, to: 3 }, context)
    const payload = JSON.parse(outcome?.content ?? '{}') as { from: number; content: string }
    expect(payload.from).toBe(2)
    expect(payload.content).toContain('#2')
  })

  it('rejects an out-of-range step', () => {
    const context = contextWith()
    const outcome = toolByName('get_step')?.run({ sessionId: first(context).id, step: 99 }, context)
    expect(outcome?.ok).toBe(false)
  })

  it('finds text across steps', () => {
    const context = contextWith()
    const outcome = toolByName('search_steps')?.run(
      { sessionId: first(context).id, query: 'timeout' },
      context,
    )
    const payload = JSON.parse(outcome?.content ?? '{}') as { hits: { step: number }[] }
    const steps = payload.hits.map((hit) => hit.step)
    expect(steps.length).toBeGreaterThan(0)
    // 第 4 步是工具消息本体；第 3 步也命中，因为配对后 assistant 步同样携带结果。
    expect(steps).toContain(4)
  })

  it('lists rules, optionally scoped to a dimension', () => {
    const context = contextWith()
    const all = JSON.parse(toolByName('list_rules')?.run({}, context)?.content ?? '{}') as { total: number }
    const scoped = JSON.parse(
      toolByName('list_rules')?.run({ dimension: 'efficiency' }, context)?.content ?? '{}',
    ) as { rules: { dimension: string }[] }
    expect(all.total).toBeGreaterThan(0)
    expect(scoped.rules.every((rule) => rule.dimension === 'efficiency')).toBe(true)
    // 清单不带表达式：带了必然超长度上限，模型就会拿到半截 JSON。
    expect(JSON.stringify(all)).not.toContain('expr')
  })

  it('simulates a draft pack without touching the real one', () => {
    const context = contextWith()
    const before = first(context)
    const outcome = toolByName('simulate_pack')?.run(
      { edits: [{ ruleId: 'exec-tool-error', enabled: false }] },
      context,
    )
    const payload = JSON.parse(outcome?.content ?? '{}') as {
      valid: boolean
      applied: { ruleId: string; effectiveImpact: number }[]
      rows: { before: number; after: number }[]
    }

    expect(outcome?.ok).toBe(true)
    expect(payload.valid).toBe(true)
    // 有效扣分由工具算：模型自己乘严重度系数会算错（实测踩过）。
    expect(payload.applied[0]?.effectiveImpact).toBeGreaterThan(0)
    // 关掉一条扣分规则，分数不可能更低——这是逻辑必然，不依赖具体数值。
    expect(payload.rows[0]!.after).toBeGreaterThanOrEqual(payload.rows[0]!.before)
    // 原包未被改动
    expect(DEFAULT_PACK.rules.find((rule) => rule.id === 'exec-tool-error')?.enabled).not.toBe(false)
    expect(scoreSession(before, DEFAULT_PACK, []).overall).toBe(payload.rows[0]!.before)
  })

  it('rejects a simulate with unknown rule ids', () => {
    const context = contextWith()
    const outcome = toolByName('simulate_pack')?.run({ edits: [{ ruleId: 'ghost' }] }, context)
    expect(outcome?.ok).toBe(false)
    expect(outcome?.content).toContain('missing')
  })

  it('rejects a draft pack that breaks the contract', () => {
    const context = contextWith()
    const outcome = toolByName('simulate_pack')?.run(
      { edits: [{ ruleId: 'exec-tool-error', expr: 'this is not an expression at all' }] },
      context,
    )
    expect(outcome?.ok).toBe(false)
    expect(outcome?.content).toContain('契约校验')
  })

  it('lists numeric literals and checks a replacement still compiles', () => {
    const context = contextWith()
    const listed = JSON.parse(
      toolByName('tune_literal')?.run({ ruleId: 'exec-tool-error' }, context)?.content ?? '{}',
    ) as { literals: { value: number }[] }
    expect(listed.literals.length).toBeGreaterThan(0)

    const replaced = toolByName('tune_literal')?.run(
      { ruleId: 'exec-tool-error', index: 0, next: 7 },
      context,
    )
    expect(replaced?.ok).toBe(true)
    expect(replaced?.content).toContain('after')
  })

  it('refuses a tuning that no longer compiles', () => {
    const context = contextWith()
    // 负下标没有任何数字常量可换
    const outcome = toolByName('tune_literal')?.run({ ruleId: 'exec-tool-error', index: 99, next: 1 }, context)
    expect(outcome?.ok).toBe(false)
  })

  it('compares two sessions but not a session with itself', () => {
    const context = contextWith()
    const [firstSession, secondSession] = context.sessions
    if (!firstSession || !secondSession) throw new Error('need two sessions')

    const same = toolByName('compare_sessions')?.run(
      { baseId: firstSession.id, targetId: firstSession.id },
      context,
    )
    expect(same?.ok).toBe(false)

    const diff = toolByName('compare_sessions')?.run(
      { baseId: firstSession.id, targetId: secondSession.id },
      context,
    )
    const payload = JSON.parse(diff?.content ?? '{}') as { overall: { delta: number } }
    expect(diff?.ok).toBe(true)
    expect(typeof payload.overall.delta).toBe('number')
  })

  it('records a proposal without touching the active pack', () => {
    const context = { ...contextWith(), proposals: [] as PackProposal[] }
    const outcome = toolByName('propose_pack')?.run(
      {
        rationale: '执行维扣分偏轻：死循环只降 25 分',
        edits: [{ ruleId: 'exec-dead-loop', severity: 'error', scoreImpact: 30 }],
      },
      context,
    )
    const payload = JSON.parse(outcome?.content ?? '{}') as {
      accepted: boolean
      appliedToWorkspace: boolean
      averageBefore: number
    }

    expect(payload.accepted).toBe(true)
    // 明确告诉模型「没生效」：否则它会在结论里写「已修复」。
    expect(payload.appliedToWorkspace).toBe(false)
    expect(payload.averageBefore).toBeGreaterThan(0)

    const proposal = context.proposals[0]
    if (!proposal) throw new Error('proposal not collected')
    expect(proposal.id).toBe('p1')
    expect(proposal.pack.name).toContain('提案 1')
    expect(proposal.pack.rules.find((rule) => rule.id === 'exec-dead-loop')?.scoreImpact).toBe(30)
    expect(proposal.applied[0]?.effectiveImpact).toBe(30)
    // 生效包不能被悄悄改掉
    expect(DEFAULT_PACK.rules.find((rule) => rule.id === 'exec-dead-loop')?.scoreImpact).not.toBe(30)
  })

  it('numbers proposals in order', () => {
    const context = { ...contextWith(), proposals: [] as PackProposal[] }
    const run = toolByName('propose_pack')
    run?.run({ rationale: 'a', edits: [{ ruleId: 'exec-dead-loop', scoreImpact: 20 }] }, context)
    run?.run({ rationale: 'b', edits: [{ ruleId: 'exec-dead-loop', scoreImpact: 40 }] }, context)
    expect(context.proposals?.map((proposal) => proposal.id)).toEqual(['p1', 'p2'])
  })

  it('refuses a proposal without a rationale', () => {
    const context = { ...contextWith(), proposals: [] as PackProposal[] }
    const outcome = toolByName('propose_pack')?.run(
      { edits: [{ ruleId: 'exec-dead-loop', scoreImpact: 20 }] },
      context,
    )
    expect(outcome?.ok).toBe(false)
    expect(context.proposals).toHaveLength(0)
  })

  it('refuses a proposal that breaks the contract, and records nothing', () => {
    const context = { ...contextWith(), proposals: [] as PackProposal[] }
    const outcome = toolByName('propose_pack')?.run(
      { rationale: 'r', edits: [{ ruleId: 'exec-dead-loop', expr: 'this is not an expression' }] },
      context,
    )
    expect(outcome?.ok).toBe(false)
    expect(outcome?.content).toContain('契约校验')
    expect(context.proposals).toHaveLength(0)
  })

  it('refuses a proposal for an unknown rule', () => {
    const context = { ...contextWith(), proposals: [] as PackProposal[] }
    const outcome = toolByName('propose_pack')?.run(
      { rationale: 'r', edits: [{ ruleId: 'ghost', scoreImpact: 20 }] },
      context,
    )
    expect(outcome?.ok).toBe(false)
    expect(outcome?.content).toContain('missing')
  })

  it('rejects a diagnosis without a verdict', () => {
    expect(parseDiagnosis({})).toBeNull()
    expect(parseDiagnosis({ verdict: '有结论' })).toEqual({ verdict: '有结论', rootCauses: [], actions: [] })
  })

  it('drops malformed root causes and actions instead of trusting them', () => {
    const diagnosis = parseDiagnosis({
      verdict: 'v',
      rootCauses: [{ evidence: '没有 cause 字段' }, { cause: '真的原因', evidence: '第 2 步' }],
      actions: [{ rationale: '没有 action 字段' }, { action: '提高扣分' }],
    })
    expect(diagnosis?.rootCauses).toHaveLength(1)
    expect(diagnosis?.actions).toHaveLength(1)
  })
})
