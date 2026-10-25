/** 一条被判「死循环，轨迹基本不可用」的轨迹，等级却写着 C「合格」。
 *
 *  有 error 级问题时总分封顶 74（ADR-0003），74 恰好是 C 的上沿，所以「有严重问题」的轨迹最高就是 C。
 *  C 的字面是「合格」，规则自己的话却是「基本不可用」，同一份报告里两句话打架。
 *  分数与字母都不动（封顶是 ADR 定的，字母是给 CI 的契约），只让 C 的标签说实话。 */

import { describe, expect, it } from 'vitest'
import type { Finding } from '../model'
import { DIMENSIONS } from '../rules/builtin-pack'
import { gradeKeyOf, gradeOf, scoreTrajectory } from './score'

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f',
    ruleId: 'r',
    ruleTitle: 't',
    dimension: 'execution',
    severity: 'warn',
    message: 'm',
    impact: 10,
    ...overrides,
  }
}

describe('gradeKeyOf', () => {
  const card = (grade: string, error: number) => ({ grade, counts: { error, warn: 0, info: 0 } })

  it('relabels a C that carries an error-level finding', () => {
    expect(gradeKeyOf(card('C', 1))).toBe('C.gated')
    expect(gradeKeyOf(card('C', 5))).toBe('C.gated')
  })

  it('leaves an ordinary C alone', () => {
    expect(gradeKeyOf(card('C', 0))).toBe('C')
  })

  it('leaves every other grade alone, errors or not', () => {
    for (const grade of ['A', 'B', 'D', 'E']) {
      expect(gradeKeyOf(card(grade, 0))).toBe(grade)
      expect(gradeKeyOf(card(grade, 3))).toBe(grade)
    }
  })
})

describe('scoreTrajectory with an error-level finding', () => {
  it('caps at 74 and lands in C, and the card says it is not merely acceptable', () => {
    const card = scoreTrajectory([finding({ severity: 'error', impact: 5 })], DIMENSIONS)
    expect(card.overall).toBe(74)
    expect(card.grade).toBe('C')
    expect(card.gradeLabel).not.toBe('合格')
    expect(card.gradeLabel).toBe('有严重问题')
  })

  it('keeps the letter and the score exactly as the gate defined them', () => {
    // 字母是给 CI 的契约，封顶是 ADR-0003：这次只动标签，不动这两样
    const card = scoreTrajectory([finding({ severity: 'error', impact: 1 })], DIMENSIONS)
    expect({ overall: card.overall, grade: card.grade, capped: card.capped }).toEqual({
      overall: 74,
      grade: 'C',
      capped: true,
    })
  })

  it('still says 合格 for a C that has no error-level finding', () => {
    // 结构、执行两维各被同一条规则命中 3 次（单条规则最多计 3 次），每次扣 17 → 各扣 51。
    // 加权后总分约 71：落在 C 的 60–74 之间，但全是 warn，没有 error，确实只是「合格」。
    const warns = (['structure', 'execution'] as const).flatMap((dimension) =>
      Array.from({ length: 3 }, (_, i) =>
        finding({
          id: `${dimension}-${i}`,
          ruleId: `rule-${dimension}`,
          severity: 'warn',
          impact: 17,
          dimension,
        }),
      ),
    )
    const card = scoreTrajectory(warns, DIMENSIONS)
    expect(card.overall).toBeGreaterThanOrEqual(60)
    expect(card.overall).toBeLessThanOrEqual(74)
    expect(card.capped).toBe(false)
    expect(card.grade).toBe('C')
    expect(card.counts.error).toBe(0)
    expect(card.gradeLabel).toBe('合格')
  })

  it('does not relabel D or E, which already read as a problem', () => {
    const five = Array.from({ length: 5 }, (_, i) =>
      finding({ id: `e${i}`, ruleId: `rule-${i}`, severity: 'error', impact: 25 }),
    )
    const card = scoreTrajectory(five, DIMENSIONS)
    expect(card.grade).toBe('E')
    expect(card.gradeLabel).toBe(gradeOf(card.overall).label)
  })

  it('a manual error annotation counts as an error too, since the gate counts it', () => {
    const card = scoreTrajectory(
      [finding({ ruleId: 'manual', severity: 'error', manual: true, impact: 8 })],
      DIMENSIONS,
    )
    expect(card.overall).toBe(74)
    expect(gradeKeyOf(card)).toBe('C.gated')
  })

  it('an error finding on a dimension the pack dropped no longer gates, so no relabel either', () => {
    const card = scoreTrajectory([finding({ severity: 'error', dimension: 'ghost' })], DIMENSIONS)
    expect(card.counts.error).toBe(0)
    expect(gradeKeyOf(card)).toBe(card.grade)
  })
})
