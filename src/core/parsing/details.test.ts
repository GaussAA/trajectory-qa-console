/** 三处细节，各自会悄悄给出错的结论：
 *  - JSONL 报错的行号数错（空行被过滤后用的是过滤后的下标）；
 *  - 显式的 `is_error: false` 压不住「正文以 Error 开头」的前缀启发式；
 *  - 工具结果没写 `is_error` 与明确写了 `false` 是两回事，不能都折成 false。 */

import { describe, expect, it } from 'vitest'
import { parseLoose, parseTrajectory } from './index'

describe('JSONL error line numbers', () => {
  const good = JSON.stringify({ role: 'user', content: 'hi' })

  it('points at the real line when blank lines come before the bad one', () => {
    // 第 1 行好，第 2 行空，第 3 行坏：之前报「第 2 行」，实际是第 3 行
    const result = parseLoose(`${good}\n\n{"role":\n${good}`)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.detail).toEqual({ line: 3 })
    expect(result.error.message).toContain('第 3 行')
  })

  it('counts leading blank lines too', () => {
    const result = parseLoose(`\n\n${good}\n{bad`)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.detail).toEqual({ line: 4 })
  })

  it('counts CRLF line endings the same way', () => {
    const result = parseLoose(`${good}\r\n\r\n{bad\r\n`)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.detail).toEqual({ line: 3 })
  })

  it('still parses a JSONL file with blank lines in it', () => {
    const result = parseLoose(`${good}\n\n${good}\n`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(2)
  })

  it('still rejects a single non-JSON line as plain invalid JSON', () => {
    const result = parseLoose('这不是 JSON')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toBe('不是合法的 JSON')
  })
})

describe('tool result error flag', () => {
  function resultOf(message: Record<string, unknown>) {
    const parsed = parseTrajectory(
      JSON.stringify([
        { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', ...message },
      ]),
      'x.json',
    )
    if (!parsed.ok) throw new Error(parsed.error.message)
    return parsed.value[0]?.steps[1]?.result
  }

  it('lets an explicit is_error:false override a body that merely starts with the word Error', () => {
    // 一份叫「Error handling guide」的文档，工具明确说没出错
    expect(resultOf({ is_error: false, content: 'Error handling guide: retry with backoff' })?.isError).toBe(false)
    expect(resultOf({ isError: false, content: 'Exception safety notes' })?.isError).toBe(false)
  })

  it('lets an explicit is_error:true stand even when the body looks fine', () => {
    expect(resultOf({ is_error: true, content: '一切正常' })?.isError).toBe(true)
  })

  it('falls back to the body prefix only when the trace says nothing', () => {
    expect(resultOf({ content: 'Error: timeout' })?.isError).toBe(true)
    expect(resultOf({ content: 'Traceback (most recent call last):' })?.isError).toBe(true)
    expect(resultOf({ content: '查到了 3 条结果' })?.isError).toBe(false)
  })

  it('treats a null flag as absent, not as false', () => {
    expect(resultOf({ is_error: null, content: 'Error: boom' })?.isError).toBe(true)
  })

  it('honours the same rule for Anthropic tool_result parts', () => {
    const parsed = parseTrajectory(
      JSON.stringify([
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 's', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'Error handling guide', is_error: false }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a2', name: 's', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a2', content: 'Error: boom' }] },
        { role: 'assistant', content: 'done' },
      ]),
      'x.json',
    )
    if (!parsed.ok) throw new Error(parsed.error.message)
    const steps = parsed.value[0]?.steps ?? []
    expect(steps[1]?.result?.isError).toBe(false)
    // 没写 is_error 的那个仍然靠前缀判断
    expect(steps[3]?.result?.isError).toBe(true)
  })
})
