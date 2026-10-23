import { describe, expect, it } from 'vitest'
import type { Finding, Severity } from '../model'
import { adviceFor, buildAdvice } from './advice'

function finding(ruleId: string, severity: Severity = 'warn', manual = false): Finding {
  return {
    id: `${ruleId}-${Math.random()}`,
    ruleId,
    ruleTitle: ruleId,
    dimension: 'structure',
    severity,
    message: 'x',
    impact: 5,
    manual,
  }
}

describe('buildAdvice', () => {
  it('groups repeated rules and counts them', () => {
    const advice = buildAdvice(
      [finding('exec-dead-loop', 'error'), finding('exec-dead-loop', 'error')],
      'zh-CN',
    )
    expect(advice).toHaveLength(1)
    expect(advice[0]?.count).toBe(2)
    expect(advice[0]?.text).toContain('最大轮次')
  })

  it('orders by severity, then by count', () => {
    const advice = buildAdvice(
      [
        finding('eff-long-trace', 'warn'),
        finding('eff-long-trace', 'warn'),
        finding('structure-invalid-args', 'error'),
        finding('structure-no-system', 'info'),
      ],
      'zh-CN',
    )
    expect(advice.map((item) => item.ruleId)).toEqual([
      'structure-invalid-args',
      'eff-long-trace',
      'structure-no-system',
    ])
  })

  it('promotes a rule to the worst severity it hit', () => {
    const advice = buildAdvice(
      [finding('exec-tool-error', 'info'), finding('exec-tool-error', 'warn')],
      'zh-CN',
    )
    expect(advice[0]?.severity).toBe('warn')
  })

  it('skips rules without a concrete action instead of inventing filler', () => {
    const advice = buildAdvice([finding('structure-multimodal', 'info')], 'zh-CN')
    expect(advice).toEqual([])
  })

  it('ignores manual annotations', () => {
    expect(buildAdvice([finding('exec-dead-loop', 'error', true)], 'zh-CN')).toEqual([])
  })

  it('respects the limit and stays stable for ties', () => {
    const many = [
      'exec-dead-loop',
      'exec-retry-storm',
      'exec-unfinished',
      'eff-no-tools',
      'eff-token-budget',
    ].map((ruleId) => finding(ruleId, 'warn'))
    const advice = buildAdvice(many, 'zh-CN', 3)
    expect(advice).toHaveLength(3)
    expect(advice.map((item) => item.ruleId)).toEqual(['eff-no-tools', 'eff-token-budget', 'exec-dead-loop'])
  })

  it('localizes the advice text', () => {
    const zh = buildAdvice([finding('exec-dead-loop', 'error')], 'zh-CN')[0]
    const en = buildAdvice([finding('exec-dead-loop', 'error')], 'en')[0]
    expect(zh?.text).not.toBe(en?.text)
    expect(en?.text).toContain('max-turns')
  })

  it('advises on semantic findings by their generated rule id', () => {
    expect(adviceFor('zh-CN', 'semantic.llm.unsafe')).toContain('合规')
    expect(adviceFor('zh-CN', 'semantic.llm.unknown')).toBeNull()
  })
})
