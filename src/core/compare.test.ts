import { describe, expect, it } from 'vitest'
import type { Finding, Step } from './model'
import { DEFAULT_PACK } from './rules/builtin-pack'
import { analyze } from './analysis'
import { scoreSession, type SessionAnalysis } from './analysis'
import { alignSteps, compareCards, diffFindings, stepSignature, summarizeAlignment } from './compare'

function step(index: number, role: Step['role'], text: string, toolNames: string[] = []): Step {
  return {
    index,
    role,
    text,
    reasoning: '',
    toolCalls: toolNames.map((name, position) => ({
      id: `c${position}`,
      name,
      rawArgs: '{}',
      args: {},
      argsValid: true,
    })),
    tokens: { input: 0, output: 0, total: 0, estimated: true },
    charCount: text.length,
    raw: {},
    parseNotes: [],
  }
}

function finding(ruleId: string, stepIndex: number | undefined, message = 'x'): Finding {
  return {
    id: `${ruleId}-${stepIndex}`,
    ruleId,
    ruleTitle: ruleId,
    dimension: 'structure',
    severity: 'warn',
    message,
    stepIndex,
    impact: 5,
  }
}

function side(source: string, label: string) {
  const parsed = analyze({ source, label, pack: DEFAULT_PACK })
  if (!parsed.ok) throw new Error(parsed.error.message)
  const analysis = parsed.value[0] as SessionAnalysis
  return { card: scoreSession(analysis, DEFAULT_PACK.dimensions), trajectory: analysis.trajectory }
}

const GOOD = JSON.stringify([
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '查报销标准' },
  { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":"x"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: '500 元' },
  { role: 'assistant', content: '上限 500 元。' },
])

const WORSE = JSON.stringify([
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '查报销标准' },
  { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":' } }] },
])

describe('compareCards', () => {
  it('reports score, dimension, step and token deltas', () => {
    const diff = compareCards(side(GOOD, 'a.json'), side(WORSE, 'b.json'))
    expect(diff.overall.before).toBe(100)
    expect(diff.overall.after).toBeLessThan(100)
    expect(diff.overall.delta).toBe(diff.overall.after - diff.overall.before)
    expect(diff.grade.before).toBe('A')
    expect(diff.steps.delta).toBe(-2)
    expect(diff.tokens.after).toBeLessThan(diff.tokens.before)
    expect(diff.dimensions.map((dimension) => dimension.id)).toEqual(DEFAULT_PACK.dimensions.map((d) => d.id))
    expect(diff.counts.find((count) => count.severity === 'error')?.delta).toBeGreaterThan(0)
  })

  it('is all zeros when both sides are the same trace', () => {
    const diff = compareCards(side(GOOD, 'a.json'), side(GOOD, 'b.json'))
    expect(diff.overall.delta).toBe(0)
    expect(diff.dimensions.every((dimension) => dimension.delta === 0)).toBe(true)
    expect(diff.counts.every((count) => count.delta === 0)).toBe(true)
  })
})

describe('diffFindings', () => {
  it('splits findings into added / resolved / persisted', () => {
    const before = [finding('a', 1), finding('b', 2)]
    const after = [finding('b', 2), finding('c', 3)]
    const diff = diffFindings(before, after)
    expect(diff.added.map((item) => item.ruleId)).toEqual(['c'])
    expect(diff.resolved.map((item) => item.ruleId)).toEqual(['a'])
    expect(diff.persisted.map((item) => item.ruleId)).toEqual(['b'])
    expect(diff.netChange).toBe(0)
  })

  it('treats the same rule on different steps as different findings', () => {
    const diff = diffFindings([finding('a', 1)], [finding('a', 2)])
    expect(diff.added).toHaveLength(1)
    expect(diff.resolved).toHaveLength(1)
  })

  it('counts the net change', () => {
    const diff = diffFindings([], [finding('a', 1), finding('b', 2)])
    expect(diff.netChange).toBe(2)
    expect(diff.resolved).toHaveLength(0)
  })
})

describe('alignSteps', () => {
  it('aligns by structure, not by text', () => {
    const before = [step(0, 'user', '旧问题'), step(1, 'assistant', '旧回答')]
    const after = [step(0, 'user', '新问题'), step(1, 'assistant', '新回答')]
    const rows = alignSteps(before, after)
    expect(rows.map((row) => row.status)).toEqual(['changed', 'changed'])
    expect(summarizeAlignment(rows)).toMatchObject({ same: 0, changed: 2, added: 0, removed: 0 })
  })

  it('detects added and removed steps', () => {
    const before = [step(0, 'user', 'q'), step(1, 'assistant', 'a')]
    const after = [step(0, 'user', 'q'), step(1, 'assistant', 'a', ['search']), step(2, 'tool', 'r')]
    const rows = alignSteps(before, after)
    // 结构签名不同（助手步多了工具调用），因此不会强行对齐：先删后增。
    expect(rows.map((row) => row.status)).toEqual(['same', 'removed', 'added', 'added'])
    expect(summarizeAlignment(rows)).toMatchObject({ same: 1, added: 2, removed: 1 })
  })

  it('marks identical steps as unchanged', () => {
    const steps = [step(0, 'user', 'q'), step(1, 'assistant', 'a')]
    const rows = alignSteps(steps, steps)
    expect(rows.every((row) => row.status === 'same')).toBe(true)
  })

  it('falls back to positional pairing past the cell limit and says so by statuses', () => {
    const before = [step(0, 'user', 'q'), step(1, 'assistant', 'a')]
    const after = [step(0, 'user', 'q'), step(1, 'assistant', 'b'), step(2, 'user', 'x')]
    const rows = alignSteps(before, after, 1)
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.status)).toEqual(['same', 'changed', 'added'])
  })

  it('handles empty sides', () => {
    expect(alignSteps([], [])).toEqual([])
    expect(alignSteps([], [step(0, 'user', 'q')])[0]?.status).toBe('added')
    expect(alignSteps([step(0, 'user', 'q')], [])[0]?.status).toBe('removed')
  })

  it('builds a structural signature from role and tool names', () => {
    expect(stepSignature(step(0, 'assistant', 'x', ['search', 'fetch']))).toBe('assistant|search,fetch')
    expect(stepSignature(step(0, 'user', 'other text'))).toBe('user|')
  })
})
