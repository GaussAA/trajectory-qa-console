import { describe, expect, it } from 'vitest'
import { parseReply } from './chat'

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
