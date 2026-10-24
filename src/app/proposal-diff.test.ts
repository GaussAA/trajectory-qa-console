import { describe, expect, it } from 'vitest'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { diffEdits } from './proposal-diff'

describe('diffEdits', () => {
  it('lists field-level changes in a stable order', () => {
    const diffs = diffEdits(DEFAULT_PACK, [
      { ruleId: 'exec-dead-loop', scoreImpact: 40, severity: 'warn', enabled: false },
    ])

    // 固定顺序：severity → scoreImpact → enabled → expr。同一份提案每次读起来顺序一致。
    expect(diffs.map((diff) => diff.field)).toEqual(['severity', 'scoreImpact', 'enabled'])
    expect(diffs[1]).toEqual({
      ruleId: 'exec-dead-loop',
      field: 'scoreImpact',
      before: String(DEFAULT_PACK.rules.find((r) => r.id === 'exec-dead-loop')?.scoreImpact),
      after: '40',
    })
  })

  it('skips edits that already match the current pack', () => {
    const rule = DEFAULT_PACK.rules.find((item) => item.id === 'exec-dead-loop')
    if (!rule) throw new Error('fixture missing rule')
    expect(diffEdits(DEFAULT_PACK, [{ ruleId: rule.id, scoreImpact: rule.scoreImpact }])).toEqual([])
  })

  it('skips rules that no longer exist', () => {
    expect(diffEdits(DEFAULT_PACK, [{ ruleId: 'ghost', scoreImpact: 1 }])).toEqual([])
  })
})
