import { describe, expect, it } from 'vitest'
import { parseTrajectory } from './index'

function mustParse(text: string, label = 'demo.json') {
  const result = parseTrajectory(text, label)
  if (!result.ok) throw new Error(`parse failed: ${result.error.message}`)
  return result.value
}

describe('parseTrajectory', () => {
  it('parses OpenAI chat messages and pairs tool results by call id', () => {
    const input = JSON.stringify([
      { role: 'system', content: '你是检索助手' },
      { role: 'user', content: '查一下政策' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"政策"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'search', content: '政策原文' },
      { role: 'assistant', content: '已完成' },
    ])

    const [trajectory] = mustParse(input)
    expect(trajectory?.steps).toHaveLength(5)
    expect(trajectory?.steps[2]?.toolCalls[0]?.name).toBe('search')
    expect(trajectory?.steps[2]?.toolCalls[0]?.args).toEqual({ q: '政策' })
    expect(trajectory?.steps[2]?.toolCalls[0]?.result?.content).toBe('政策原文')
    expect(trajectory?.steps[3]?.forCallId).toBe('c1')
    expect(trajectory?.label).toBe('demo.json')
  })

  it('splits JSONL with one session per line', () => {
    const input = [
      JSON.stringify({ session_id: 's-1', messages: [{ role: 'user', content: '你好' }] }),
      JSON.stringify({ session_id: 's-2', messages: [{ role: 'user', content: '再会' }] }),
    ].join('\n')

    const trajectories = mustParse(input, 'batch.jsonl')
    expect(trajectories).toHaveLength(2)
    expect(trajectories.map((trajectory) => trajectory.label)).toEqual(['s-1', 's-2'])
  })

  it('reads Anthropic-style tool_use / tool_result parts', () => {
    const input = JSON.stringify([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我先查一下' },
          { type: 'tool_use', id: 'tu-1', name: 'lookup', input: { id: 7 } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: [{ type: 'text', text: '42' }] }],
      },
    ])

    const [trajectory] = mustParse(input)
    expect(trajectory?.steps[0]?.text).toBe('我先查一下')
    expect(trajectory?.steps[0]?.toolCalls[0]?.args).toEqual({ id: 7 })
    expect(trajectory?.steps[0]?.toolCalls[0]?.result?.content).toBe('42')
    expect(trajectory?.steps[1]?.role).toBe('tool')
    expect(trajectory?.steps[1]?.forCallId).toBe('tu-1')
  })

  it('flags malformed tool arguments instead of failing the parse', () => {
    const input = JSON.stringify([
      {
        role: 'assistant',
        tool_calls: [{ id: 'bad', function: { name: 'write', arguments: '{"path": ' } }],
      },
    ])

    const [trajectory] = mustParse(input)
    expect(trajectory?.steps[0]?.toolCalls[0]?.argsValid).toBe(false)
    expect(trajectory?.steps[0]?.parseNotes.join(' ')).toContain('非法 JSON')
  })

  it('keeps orphan tool results visible and notes the broken link', () => {
    const input = JSON.stringify([
      { role: 'assistant', content: '没有调用' },
      { role: 'tool', tool_call_id: 'ghost', content: '孤立的返回值' },
    ])

    const [trajectory] = mustParse(input)
    expect(trajectory?.steps[1]?.forCallId).toBeUndefined()
    expect(trajectory?.parseNotes.join(' ')).toContain('不存在的调用')
  })

  it('unwraps nested containers and single messages', () => {
    const wrapped = mustParse(JSON.stringify({ data: { messages: [{ role: 'user', content: 'hi' }] } }))
    expect(wrapped[0]?.steps).toHaveLength(1)
  })

  it('uses reported usage when present and estimates otherwise', () => {
    const input = JSON.stringify([
      { role: 'assistant', content: 'hello', usage: { prompt_tokens: 10, completion_tokens: 5 } },
      { role: 'assistant', content: '这是一段没有 usage 的中文回复' },
    ])

    const [trajectory] = mustParse(input)
    expect(trajectory?.steps[0]?.tokens).toMatchObject({ total: 15, estimated: false })
    expect(trajectory?.steps[1]?.tokens.estimated).toBe(true)
    expect(trajectory?.meta.estimatedTokens).toBe(true)
  })

  it('reads OpenAI Responses style function_call items', () => {
    const input = JSON.stringify([
      { type: 'function_call', call_id: 'fc-1', name: 'weather', arguments: '{"city":"合肥"}' },
      { type: 'function_call_output', call_id: 'fc-1', output: '晴，26℃' },
    ])

    const [trajectory] = mustParse(input)
    expect(trajectory?.steps[0]?.role).toBe('assistant')
    expect(trajectory?.steps[0]?.toolCalls[0]?.result?.content).toBe('晴，26℃')
    expect(trajectory?.steps[1]?.forCallId).toBe('fc-1')
  })

  it('returns a Result instead of throwing on unusable input', () => {
    const notJson = parseTrajectory('这不是 JSON', 'x')
    expect(notJson.ok).toBe(false)
    if (!notJson.ok) expect(notJson.error.code).toBe('invalid-json')

    const empty = parseTrajectory('   ', 'x')
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error.code).toBe('empty-input')

    const wrongShape = parseTrajectory('{"foo":1}', 'x')
    expect(wrongShape.ok).toBe(false)
    if (!wrongShape.ok) expect(wrongShape.error.code).toBe('unrecognized-structure')
  })

  it('enforces the step ceiling before building steps', () => {
    const input = JSON.stringify(
      Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `m${i}` })),
    )
    const result = parseTrajectory(input, 'x', { maxSteps: 3 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('too-many-steps')
  })
})
