import { describe, expect, it } from 'vitest'
import { analyze } from '../analysis'
import { DEFAULT_PACK } from './builtin-pack'
import { numericLiterals, replaceLiteral, buildTuningReport } from './tuning'
import { compileExpression } from '../expr'

const TRACE = JSON.stringify([
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '查一下' },
  {
    role: 'assistant',
    tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":' } }],
  },
])

function sessionFrom(source: string, label = 'trace.json') {
  const parsed = analyze({ source, label })
  if (!parsed.ok) throw new Error(parsed.error.message)
  const analysis = parsed.value.sessions[0]!
  return { id: analysis.id, trajectory: analysis.trajectory }
}

describe('numericLiterals', () => {
  it('finds plain and decimal numbers', () => {
    expect(numericLiterals('stepCount > 40').map((item) => item.value)).toEqual([40])
    expect(numericLiterals('errorRate >= 0.3').map((item) => item.value)).toEqual([0.3])
    expect(numericLiterals('a > 1 and b < 2').map((item) => item.value)).toEqual([1, 2])
  })

  it('ignores numbers inside strings and identifiers', () => {
    expect(numericLiterals('role == "gpt4"')).toEqual([])
    expect(numericLiterals('model == "claude-3-5"')).toEqual([])
    expect(numericLiterals('stepIdx1 > 2').map((item) => item.value)).toEqual([2])
  })

  it('records positions that map back to the source', () => {
    const expr = 'stepCount > 40 and totalTokens > 60000'
    const literals = numericLiterals(expr)
    expect(literals).toHaveLength(2)
    for (const literal of literals) {
      expect(expr.slice(literal.start, literal.end)).toBe(literal.text)
    }
  })
})

describe('replaceLiteral', () => {
  it('replaces only the requested occurrence', () => {
    const expr = 'a > 10 and b > 20'
    expect(replaceLiteral(expr, 1, 5)).toBe('a > 10 and b > 5')
    expect(replaceLiteral(expr, 0, 5)).toBe('a > 5 and b > 20')
  })

  it('keeps the result compilable or refuses', () => {
    const expr = 'stepCount > 40'
    const next = replaceLiteral(expr, 0, 12)
    expect(next).toBe('stepCount > 12')
    expect(() => compileExpression(next as string)).not.toThrow()

    expect(replaceLiteral(expr, 9, 1)).toBeNull()
    expect(replaceLiteral(expr, 0, Number.NaN)).toBeNull()
  })

  it('does not corrupt quoted strings that contain digits', () => {
    expect(replaceLiteral('role == "gpt4"', 0, 7)).toBeNull()
  })
})

describe('buildTuningReport', () => {
  const session = sessionFrom(TRACE)

  it('counts hits per rule and reports the score', () => {
    const report = buildTuningReport([session], DEFAULT_PACK)
    expect(report.scores).toHaveLength(1)
    expect(report.average).toBe(report.scores[0]?.score)
    expect(report.totalHits).toBeGreaterThan(0)
    expect(report.rules.find((rule) => rule.ruleId === 'structure-invalid-args')?.hits).toBe(1)
  })

  it('scores a disabled rule as having no effect on the gain', () => {
    const pack = { ...DEFAULT_PACK, rules: DEFAULT_PACK.rules.map((rule) => ({ ...rule, enabled: false })) }
    const report = buildTuningReport([session], pack)
    expect(report.totalHits).toBe(0)
    expect(report.rules.every((rule) => rule.avgGain === 0)).toBe(true)
  })

  it('reports the score gain from removing a specific rule', () => {
    // 只留一条规则，便于把「禁用后涨多少分」算清楚。
    const only = {
      ...DEFAULT_PACK,
      rules: DEFAULT_PACK.rules.filter((rule) => rule.id === 'exec-tool-error'),
    }
    const report = buildTuningReport([session], {
      ...only,
      rules: only.rules.map((rule) => ({ ...rule, expr: 'true' })),
    })
    expect(report.average).toBeLessThan(100)
    expect(report.rules[0]?.hits).toBeGreaterThan(0)
    expect(report.rules[0]?.maxGain).toBeGreaterThan(0)
  })

  it('collects broken rules instead of throwing', () => {
    const broken = {
      ...DEFAULT_PACK,
      rules: [{ ...DEFAULT_PACK.rules[0]!, expr: 'nope >' }],
    }
    const report = buildTuningReport([session], broken)
    expect(report.brokenRules).toHaveLength(1)
    expect(report.brokenRules[0]?.ruleId).toBe(DEFAULT_PACK.rules[0]?.id)
  })
})
