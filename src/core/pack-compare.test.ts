import { describe, expect, it } from 'vitest'
import { analyze } from './analysis'
import { DEFAULT_PACK } from './rules/builtin-pack'
import type { RulePack } from './model'
import type { PackOption } from './pack-compare'
import { comparePacks, scoreUnderPack } from './pack-compare'

const TRACE = JSON.stringify([
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '查一下' },
  { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":' } }] },
])

function sessions() {
  const parsed = analyze({ source: TRACE, label: 'trace.json', pack: DEFAULT_PACK })
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value
}

const strict: RulePack = { ...DEFAULT_PACK, name: '严格' }
const lenient: RulePack = {
  ...DEFAULT_PACK,
  name: '宽松',
  // 直接停用该规则：这条问题在宽松口径下彻底不出现
  rules: DEFAULT_PACK.rules.map((rule) =>
    rule.id === 'structure-invalid-args' ? { ...rule, enabled: false } : rule,
  ),
}

describe('scoreUnderPack', () => {
  it('re-runs rules under the given pack', () => {
    const [session] = sessions()
    if (!session) throw new Error('fixture did not parse')
    const underStrict = scoreUnderPack(session, strict)
    const underLenient = scoreUnderPack(session, lenient)

    expect(underStrict.findings.some((finding) => finding.ruleId === 'structure-invalid-args')).toBe(true)
    expect(underLenient.findings.some((finding) => finding.ruleId === 'structure-invalid-args')).toBe(false)
    // 总分被「严重问题封顶」兜着：少一条 error 不一定抬高 overall。
    // 口径差异落在问题数与维度得分上——这也是界面该如实呈现的。
    expect(underLenient.findings.length).toBeLessThan(underStrict.findings.length)
    const structureOf = (card: ReturnType<typeof scoreUnderPack>) =>
      card.dimensions.find((dimension) => dimension.id === 'structure')?.score ?? 0
    expect(structureOf(underLenient)).toBeGreaterThan(structureOf(underStrict))
  })
})

describe('comparePacks', () => {
  it('scores every session under both packs with deltas', () => {
    const comparison = comparePacks(sessions(), strict, lenient)

    expect(comparison.rows).toHaveLength(1)
    const row = comparison.rows[0] as (typeof comparison.rows)[number]
    expect(row.label).toBe('trace.json')
    expect(row.delta).toBe(row.target - row.base)
    // 封顶机制下总分可能持平；对比保证的是「不少于」且 identical 如实为 false
    expect(comparison.targetAverage).toBeGreaterThanOrEqual(comparison.baseAverage)
    expect(comparison.identical).toBe(false)
  })

  it('flags identical packs instead of pretending there is a difference', () => {
    const comparison = comparePacks(sessions(), DEFAULT_PACK, DEFAULT_PACK)
    expect(comparison.identical).toBe(true)
    expect(comparison.rows[0]?.delta).toBe(0)
  })

  it('keeps the average at 100 for an empty batch', () => {
    const comparison = comparePacks([], strict, lenient)
    expect(comparison.rows).toHaveLength(0)
    expect(comparison.baseAverage).toBe(100)
    expect(comparison.targetAverage).toBe(100)
  })
})

describe('PackOption shape', () => {
  it('carries id, name and pack for the picker', () => {
    const option: PackOption = { id: 'current', name: '当前包', pack: DEFAULT_PACK }
    expect(option.name).toBe('当前包')
  })
})
