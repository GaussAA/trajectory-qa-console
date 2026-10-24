/** 真实数据集和框架导出的几种常见形状。
 *
 *  这些之前的结局是「悄悄解析错、照样给高分」：ShareGPT 的 `conversations` 被当成一条消息，
 *  LangChain 的消息因为角色放在 `type` 字段里而全部变成 unknown，SWE-agent 的 `trajectory`
 *  抢在 `history` 前面被当成消息数组。认得出的要读对；认不出的要明确拒绝，不能给分。 */

import { describe, expect, it } from 'vitest'
import { analyze } from '../analysis'
import { parseTrajectory } from './index'

function parse(value: unknown) {
  const result = parseTrajectory(JSON.stringify(value), 'x.json')
  if (!result.ok) throw new Error(`parse failed: ${result.error.message}`)
  return result.value
}

const roles = (value: unknown) => (parse(value)[0]?.steps ?? []).map((step) => step.role)

describe('ShareGPT', () => {
  const conversations = [
    { from: 'system', value: '你是助手' },
    { from: 'human', value: '你好' },
    { from: 'gpt', value: '你好，有什么可以帮你？' },
  ]

  it('reads a record whose messages live under `conversations`', () => {
    const [trajectory] = parse([{ id: 'abc', conversations }])
    expect(trajectory?.steps.map((step) => step.role)).toEqual(['system', 'user', 'assistant'])
    expect(trajectory?.steps[2]?.text).toBe('你好，有什么可以帮你？')
  })

  it('reads several such records as several sessions', () => {
    expect(parse([{ conversations }, { conversations }])).toHaveLength(2)
  })

  it('reads a flat list of from/value messages', () => {
    expect(roles(conversations)).toEqual(['system', 'user', 'assistant'])
  })

  it('reads a single object with a `conversations` key', () => {
    expect(roles({ conversations })).toEqual(['system', 'user', 'assistant'])
  })
})

describe('LangChain', () => {
  const calls = [{ name: 'search', args: { q: 'a' }, id: 'c1', type: 'tool_call' }]

  it('reads a model_dump list, where the role is the `type` field', () => {
    const [trajectory] = parse([
      { type: 'human', content: 'hi' },
      { type: 'ai', content: '', tool_calls: calls },
      { type: 'tool', content: 'result', tool_call_id: 'c1', name: 'search' },
      { type: 'ai', content: 'final' },
    ])
    const steps = trajectory?.steps ?? []
    expect(steps.map((step) => step.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    // 工具结果要配得上调用，否则会凭空多出两条 error 级结构问题
    expect(steps[1]?.toolCalls[0]?.result?.content).toBe('result')
    expect(steps[2]?.forCallId).toBe('c1')
    expect(trajectory?.parseNotes).toEqual([])
  })

  it('reads messages_to_dict, where the payload sits under `data`', () => {
    const [trajectory] = parse([
      { type: 'human', data: { content: 'hi', type: 'human' } },
      { type: 'ai', data: { content: '', type: 'ai', tool_calls: calls } },
      { type: 'tool', data: { content: 'result', type: 'tool', tool_call_id: 'c1' } },
      { type: 'ai', data: { content: 'final', type: 'ai' } },
    ])
    const steps = trajectory?.steps ?? []
    expect(steps.map((step) => step.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(steps[0]?.text).toBe('hi')
    expect(steps[1]?.toolCalls[0]?.result?.content).toBe('result')
  })

  it('reads the constructor form, where the role is the class name', () => {
    const ctor = (cls: string, kwargs: Record<string, unknown>) => ({
      lc: 1,
      type: 'constructor',
      id: ['langchain', 'schema', 'messages', cls],
      kwargs,
    })
    const [trajectory] = parse([
      ctor('SystemMessage', { content: '你是助手' }),
      ctor('HumanMessage', { content: 'hi' }),
      ctor('AIMessage', { content: '', tool_calls: calls }),
      ctor('ToolMessage', { content: 'result', tool_call_id: 'c1' }),
      ctor('AIMessage', { content: 'final' }),
    ])
    const steps = trajectory?.steps ?? []
    expect(steps.map((step) => step.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant'])
    expect(steps[1]?.text).toBe('hi')
    expect(steps[2]?.toolCalls[0]?.result?.content).toBe('result')
  })

  it('keeps the original object on the step, not the unwrapped one', () => {
    const original = { type: 'human', data: { content: 'hi', type: 'human' } }
    expect((parse([original, { type: 'ai', data: { content: 'x', type: 'ai' } }])[0]?.steps[0]?.raw)).toEqual(original)
  })
})

describe('SWE-agent style records with both `trajectory` and `history`', () => {
  const record = {
    trajectory: [
      { action: 'ls', observation: 'a b', response: 'ls', thought: 't', execution_time: 0.1, state: {} },
      { action: 'submit', observation: 'done', response: 'submit', thought: 't', execution_time: 0.1, state: {} },
    ],
    history: [
      { role: 'system', content: '你是工程师' },
      { role: 'user', content: '修这个 bug' },
      { role: 'assistant', content: '先看看目录' },
      { role: 'assistant', content: '修好了' },
    ],
  }

  it('reads the messages under `history`, not the action records under `trajectory`', () => {
    expect(roles(record)).toEqual(['system', 'user', 'assistant', 'assistant'])
  })
})

describe('what must keep working', () => {
  it('does not let `type` override an explicit role', () => {
    expect(roles([{ role: 'user', type: 'ai', content: 'hi' }, { role: 'assistant', content: 'yo' }])).toEqual([
      'user',
      'assistant',
    ])
  })

  it('still reads OpenAI Responses message items', () => {
    expect(
      roles([
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'yo' }] },
      ]),
    ).toEqual(['user', 'assistant'])
  })

  it('still prefers a plain `messages` array', () => {
    expect(roles({ messages: [{ role: 'user', content: 'hi' }], history: [{ role: 'assistant', content: 'x' }] })).toEqual(
      ['user'],
    )
  })

  it('still finds messages nested under `data` when the outer array is not messages', () => {
    expect(roles({ trajectory: [{ action: 'ls' }], data: { messages: [{ role: 'user', content: 'hi' }] } })).toEqual([
      'user',
    ])
  })

  it('does not mistake an ordinary message that has a `data` field for a LangChain dump', () => {
    const [trajectory] = parse([
      { role: 'user', content: 'hi', data: { anything: 1 } },
      { role: 'assistant', content: 'yo' },
    ])
    expect(trajectory?.steps.map((step) => step.text)).toEqual(['hi', 'yo'])
  })
})

describe('formats that are NOT supported must be refused, not scored', () => {
  it('rejects OpenHands-style events instead of grading them A', () => {
    const events = [
      { id: 0, source: 'user', action: 'message', message: '修这个 bug' },
      { id: 1, source: 'agent', action: 'run', args: { command: 'ls' } },
      { id: 2, source: 'agent', observation: 'run', content: 'a b', cause: 1 },
    ]
    const result = analyze({ source: JSON.stringify(events), label: 'openhands.json' })
    expect(result.ok).toBe(false)
  })

  it('rejects a list of objects that are not messages at all', () => {
    const result = analyze({ source: JSON.stringify([{ foo: 1 }, { bar: 2 }]), label: 'junk.json' })
    expect(result.ok).toBe(false)
  })
})
