import { describe, expect, it, vi } from 'vitest'
import { type LlmTransport } from '../llm/transport'
import { runAgent } from './loop'
import { TOOLS } from './tools'
import { BASE, contextWith, scripted, turn } from './test-support'

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

  it('records the endpoint usage of every round and the rounds add up to the run total', async () => {
    const { transport } = scripted([
      turn({ calls: [{ name: 'list_sessions' }], usage: { prompt: 100, completion: 20 } }),
      turn({ calls: [{ name: 'list_sessions' }], usage: { prompt: 260, completion: 30 } }),
      turn({ content: '结论', usage: { prompt: 400, completion: 50 } }),
    ])

    const run = await runAgent(contextWith(), { ...BASE, transport })

    const modelUsage = run.trace.entries.flatMap((entry) => (entry.kind === 'model' ? [entry.usage] : []))
    expect(modelUsage).toEqual([
      { prompt: 100, completion: 20 },
      { prompt: 260, completion: 30 },
      { prompt: 400, completion: 50 },
    ])
    expect(run.usage).toEqual({
      prompt: modelUsage.reduce((sum, usage) => sum + usage.prompt, 0),
      completion: modelUsage.reduce((sum, usage) => sum + usage.completion, 0),
    })
    expect(run.usage).toEqual({ prompt: 760, completion: 100 })
  })

  it('counts a round as zero when the endpoint returns no usage instead of failing', async () => {
    const noUsage = JSON.stringify({
      choices: [{ message: { content: '没有用量字段' }, finish_reason: 'stop' }],
    })
    const { transport } = scripted([noUsage])

    const run = await runAgent(contextWith(), { ...BASE, transport })

    expect(run.ok).toBe(true)
    const model = run.trace.entries.find((entry) => entry.kind === 'model')
    expect(model?.kind === 'model' ? model.usage : null).toEqual({ prompt: 0, completion: 0 })
    expect(run.usage).toEqual({ prompt: 0, completion: 0 })
  })

  it('keeps the usage of the rounds that finished when a later round fails', async () => {
    const first = turn({ calls: [{ name: 'list_sessions' }], usage: { prompt: 120, completion: 15 } })
    let calls = 0
    const transport: LlmTransport = async () => {
      calls += 1
      return calls === 1
        ? { ok: true, status: 200, text: first }
        : { ok: false, status: 500, text: 'upstream down' }
    }

    const run = await runAgent(contextWith(), { ...BASE, transport })

    expect(run.ok).toBe(false)
    const modelUsage = run.trace.entries.flatMap((entry) => (entry.kind === 'model' ? [entry.usage] : []))
    expect(modelUsage).toEqual([{ prompt: 120, completion: 15 }])
    expect(run.usage).toEqual({ prompt: 120, completion: 15 })
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
