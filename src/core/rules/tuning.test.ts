import { describe, expect, it } from 'vitest'
import { analyzeSessions } from '../test-support'
import { DEFAULT_PACK } from './builtin-pack'
import { numericLiterals, replaceLiteral, buildTuningReport } from './tuning'
import { compileExpression } from './expr'

const TRACE = JSON.stringify([
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '查一下' },
  {
    role: 'assistant',
    tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":' } }],
  },
])

function sessionFrom(source: string, label = 'trace.json') {
  const analysis = analyzeSessions(source, label)[0]!
  return { id: analysis.id, trajectory: analysis.trajectory }
}

/** 调参面板的性能护栏：ADR-0009 说超过 50ms 就得挪出主线程，而这里此前
 *  一条护栏都没有。合成轨迹的比例与 perf.test.ts 一致，便于横向比较。 */
function bigSource(steps: number): string {
  const messages: unknown[] = [{ role: 'system', content: '你是助手，回答必须引用检索结果。' }]
  let turn = 0
  while (messages.length + 2 < steps) {
    messages.push({ role: 'user', content: `第 ${turn} 轮问题：帮我查一下政策条款。` })
    messages.push({
      role: 'assistant',
      tool_calls: [{ id: `c${turn}`, function: { name: 'search', arguments: `{"q":"q${turn}"}` } }],
    })
    messages.push({ role: 'tool', tool_call_id: `c${turn}`, content: 'x'.repeat(200) })
    turn += 1
  }
  messages.push({ role: 'assistant', content: '已完成。' })
  return JSON.stringify(messages)
}

describe('buildTuningReport performance', () => {
  it('re-runs a realistic workspace without freezing the drawer', () => {
    const sessions = Array.from({ length: 20 }, (_, index) =>
      sessionFrom(bigSource(1_000), `big-${index}.json`),
    )

    const started = performance.now()
    const report = buildTuningReport(sessions, DEFAULT_PACK)
    const ms = performance.now() - started

    expect(report.rules.length).toBe(DEFAULT_PACK.rules.length)
    expect(report.scores).toHaveLength(20)
    // 一次改包就是一次全量重算：这是用户在抽屉里每次改数字都会付的代价。
    // 预算给到 ADR-0009 警戒线的 10 倍，只防数量级退化，不绑硬件。
    expect(ms).toBeLessThan(500)
  }, 60_000)
})

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
