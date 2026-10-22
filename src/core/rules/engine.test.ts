import { describe, expect, it } from 'vitest'
import { parseTrajectory } from '../parsing'
import { DIMENSIONS, DEFAULT_PACK } from './builtin-pack'
import { buildStepContexts, runRules } from './engine'
import { annotationFindings, scoreTrajectory } from '../analysis/score'
import { validatePack, formatPackErrors, STEP_FIELDS, TRAJECTORY_FIELDS } from './contract'
import { computeMetrics } from '../analysis/metrics'
import type { RulePack } from '../model'

const CLEAN_TRACE = JSON.stringify([
  { role: 'system', content: '你是检索助手' },
  { role: 'user', content: '报销标准是多少' },
  {
    role: 'assistant',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"报销"}' } }],
  },
  { role: 'tool', tool_call_id: 'c1', name: 'search', content: '住宿上限 500 元' },
  { role: 'assistant', content: '住宿上限为 500 元。' },
])

const BROKEN_TRACE = JSON.stringify([
  { role: 'user', content: '帮我整理材料' },
  { role: 'assistant', tool_calls: [{ id: 'x1', function: { name: 'fetch', arguments: '{"url": ' } }] },
  { role: 'assistant', tool_calls: [{ id: 'x2', function: { name: 'fetch', arguments: '{"url":"a"}' } }] },
  { role: 'assistant', tool_calls: [{ id: 'x3', function: { name: 'fetch', arguments: '{"url":"a"}' } }] },
  { role: 'assistant', tool_calls: [{ id: 'x4', function: { name: 'fetch', arguments: '{"url":"a"}' } }] },
])

function parseOrThrow(trace: string) {
  const result = parseTrajectory(trace)
  if (!result.ok) throw new Error(result.error.message)
  return result.value[0]
}

function ruleIds(trace: string): string[] {
  const trajectory = parseOrThrow(trace)
  if (!trajectory) throw new Error('trace did not parse')
  return runRules(trajectory, DEFAULT_PACK).findings.map((finding) => finding.ruleId)
}

describe('rule engine', () => {
  it('leaves a healthy trace clean', () => {
    expect(ruleIds(CLEAN_TRACE)).toEqual([])
  })

  it('detects truncated calls, bad arguments, retry storms and a missing answer', () => {
    const found = ruleIds(BROKEN_TRACE)
    expect(found).toContain('structure-unpaired-call')
    expect(found).toContain('structure-invalid-args')
    expect(found).toContain('exec-retry-storm')
    expect(found).toContain('exec-unfinished')
  })

  it('detects orphan tool results whose call id points nowhere', () => {
    const trace = JSON.stringify([
      { role: 'assistant', content: '无调用' },
      { role: 'tool', tool_call_id: 'ghost', content: '孤立返回' },
    ])
    expect(ruleIds(trace)).toContain('structure-orphan-result')
  })

  it('reports a per-step finding for every offending step', () => {
    const trajectory = parseOrThrow(BROKEN_TRACE)
    if (!trajectory) throw new Error('trace did not parse')
    const { findings } = runRules(trajectory, DEFAULT_PACK)
    const unpaired = findings.filter((finding) => finding.ruleId === 'structure-unpaired-call')
    expect(unpaired).toHaveLength(4)
    expect(unpaired.map((finding) => finding.stepIndex)).toEqual([1, 2, 3, 4])
    expect(unpaired[0]?.message).toContain('第 2 步')
  })

  it('surfaces broken rules as issues instead of throwing', () => {
    const pack: RulePack = {
      version: 1,
      name: 'broken',
      dimensions: DIMENSIONS,
      rules: [
        {
          id: 'typo-rule',
          dimension: 'structure',
          severity: 'warn',
          title: 'typo',
          scoreImpact: 5,
          scope: 'trajectory',
          expr: 'stepCounter > 1',
          message: 'x',
          enabled: true,
          builtin: false,
        },
        {
          id: 'ghost-dimension',
          dimension: 'nope',
          severity: 'warn',
          title: 'ghost',
          scoreImpact: 5,
          scope: 'trajectory',
          expr: 'true',
          message: 'x',
          enabled: true,
          builtin: false,
        },
      ],
    }
    const trajectory = parseOrThrow(CLEAN_TRACE)
    if (!trajectory) throw new Error('trace did not parse')
    const result = runRules(trajectory, pack)
    expect(result.findings).toHaveLength(0)
    expect(result.ruleIssues).toHaveLength(2)
    expect(result.ruleIssues[0]?.message).toContain('未知标识符')
  })

  it('keeps manual annotations as first-class findings', () => {
    const findings = annotationFindings('t1', [
      {
        id: 'a1',
        trajectoryId: 't1',
        stepIndex: 2,
        dimension: 'semantic',
        severity: 'error',
        note: '答非所问',
      },
      { id: 'a2', trajectoryId: 't2', stepIndex: 0, dimension: 'semantic', severity: 'info', note: '忽略' },
      { id: 'a3', trajectoryId: 't1', dimension: 'semantic', severity: 'info', note: '   ' },
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ dimension: 'semantic', severity: 'error', impact: 8, stepIndex: 2 })
  })
})

describe('rule contract', () => {
  it('accepts the built-in pack', () => {
    const result = validatePack(DEFAULT_PACK)
    expect(result.ok).toBe(true)
  })

  it('keeps the published field lists in sync with the runtime contexts', () => {
    const trajectory = parseOrThrow(CLEAN_TRACE)
    if (!trajectory) throw new Error('trace did not parse')
    const [stepContext] = buildStepContexts(trajectory)
    expect(Object.keys(stepContext ?? {}).sort()).toEqual(STEP_FIELDS.map((field) => field.name).sort())

    const metrics = computeMetrics(trajectory)
    expect(Object.keys(metrics).sort()).toEqual(TRAJECTORY_FIELDS.map((field) => field.name).sort())
  })

  it('suggests the nearest legal field when a rule has a typo', () => {
    const result = validatePack({
      ...DEFAULT_PACK,
      rules: [{ ...DEFAULT_PACK.rules[0], id: 'typo', expr: 'unpairedCallz > 0' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const text = formatPackErrors(result.errors).join(' ')
      expect(text).toContain('unpairedCalls')
    }
  })

  it('rejects structurally invalid packs with actionable paths', () => {
    const result = validatePack({ dimensions: [], rules: 'nope' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const text = formatPackErrors(result.errors).join(' ')
      expect(text).toContain('dimensions')
      expect(text).toContain('rules')
    }
  })

  it('rejects duplicate ids and shared dimension weights of zero', () => {
    const duplicate = validatePack({
      ...DEFAULT_PACK,
      dimensions: [DEFAULT_PACK.dimensions[0], DEFAULT_PACK.dimensions[0]],
      rules: [DEFAULT_PACK.rules[0], DEFAULT_PACK.rules[0]],
    })
    expect(duplicate.ok).toBe(false)

    const zero = validatePack({
      version: 1,
      name: 'zero',
      dimensions: [{ id: 'a', label: 'A', weight: 0, color: '#fff', description: '' }],
      rules: [],
    })
    expect(zero.ok).toBe(false)
  })

  it('rejects unknown functions at validation time', () => {
    const result = validatePack({
      ...DEFAULT_PACK,
      rules: [{ ...DEFAULT_PACK.rules[0], id: 'fn-typo', expr: 'lenght(role) > 0' }],
    })
    expect(result.ok).toBe(false)
  })
})

describe('scoring', () => {
  it('gives a clean trace a perfect score', () => {
    const trajectory = parseOrThrow(CLEAN_TRACE)
    if (!trajectory) throw new Error('trace did not parse')
    const { findings, ruleIssues } = runRules(trajectory, DEFAULT_PACK)
    const card = scoreTrajectory(findings, DIMENSIONS, ruleIssues)
    expect(card.overall).toBe(100)
    expect(card.grade).toBe('A')
    expect(card.counts.error).toBe(0)
  })

  it('deducts per dimension and gates the headline with errors', () => {
    const card = scoreTrajectory(
      [
        {
          id: 'f1',
          ruleId: 'r1',
          ruleTitle: 'r1',
          dimension: 'structure',
          severity: 'error',
          message: 'm',
          impact: 15,
        },
      ],
      DIMENSIONS,
    )
    expect(card.dimensions.find((dimension) => dimension.id === 'structure')?.score).toBe(85)
    expect(card.rawOverall).toBe(96)
    expect(card.overall).toBe(74)
    expect(card.capped).toBe(true)
    expect(card.grade).toBe('C')
  })

  it('caps repeated occurrences of the same rule at three', () => {
    const findings = Array.from({ length: 6 }, (_, i) => ({
      id: `f${i}`,
      ruleId: 'same-rule',
      ruleTitle: 'same',
      dimension: 'structure' as const,
      severity: 'error' as const,
      message: 'm',
      impact: 10,
    }))
    const card = scoreTrajectory(findings, DIMENSIONS)
    const structure = card.dimensions.find((dimension) => dimension.id === 'structure')
    expect(structure?.lost).toBe(30)
    expect(structure?.score).toBe(70)
  })

  it('caps the headline by distinct error rules, not occurrences', () => {
    const card = scoreTrajectory(
      Array.from({ length: 9 }, (_, i) => ({
        id: `f${i}`,
        ruleId: 'one-rule',
        ruleTitle: 'one',
        dimension: 'structure' as const,
        severity: 'error' as const,
        message: 'm',
        impact: 2,
      })),
      DIMENSIONS,
    )
    expect(card.capped).toBe(true)
    expect(card.overall).toBe(74)
  })

  it('never drops a dimension below zero', () => {
    const findings = Array.from({ length: 3 }, (_, i) => ({
      id: `f${i}`,
      ruleId: `rule-${i}`,
      ruleTitle: 'r',
      dimension: 'execution' as const,
      severity: 'error' as const,
      message: 'm',
      impact: 80,
    }))
    const card = scoreTrajectory(findings, DIMENSIONS)
    expect(card.dimensions.find((dimension) => dimension.id === 'execution')?.score).toBe(0)
    expect(card.overall).toBe(54)
    expect(card.grade).toBe('D')
  })
})
