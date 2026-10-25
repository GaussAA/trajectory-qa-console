import { describe, expect, it } from 'vitest'
import { parseDiagnosis } from './index'

describe('parseDiagnosis', () => {
  it('rejects a diagnosis without a verdict', () => {
    expect(parseDiagnosis({})).toBeNull()
    expect(parseDiagnosis({ verdict: '有结论' })).toEqual({ verdict: '有结论', rootCauses: [], actions: [] })
  })

  it('drops malformed root causes and actions instead of trusting them', () => {
    const diagnosis = parseDiagnosis({
      verdict: 'v',
      rootCauses: [{ evidence: '没有 cause 字段' }, { cause: '真的原因', evidence: '第 2 步' }],
      actions: [{ rationale: '没有 action 字段' }, { action: '提高扣分' }],
    })
    expect(diagnosis?.rootCauses).toHaveLength(1)
    expect(diagnosis?.actions).toHaveLength(1)
  })
})
