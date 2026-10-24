/** Scoring: findings → per-dimension score → one headline number.
 *
 *  Two policies worth knowing:
 *  - A repeated rule is capped at 3 counted occurrences, so one systemic flaw
 *    does not floor a dimension and hide everything else.
 *  - Confirmed errors gate the headline score. We count *distinct error rules*:
 *    one flaw found forty times is still one flaw, and occurrences already cost
 *    points inside the dimension.
 */

import {
  SEVERITY_ORDER,
  type Annotation,
  type Dimension,
  type Finding,
  type RuleIssue,
  type Severity,
  type SeverityCounts,
} from '../model'

export interface DimensionScore {
  id: string
  label: string
  color: string
  weight: number
  score: number
  lost: number
  findings: number
  errors: number
  warns: number
}

export interface ScoreCard {
  overall: number
  /** Weighted mean before the error gate. */
  rawOverall: number
  /** True when the error gate lowered the score. */
  capped: boolean
  grade: string
  gradeLabel: string
  dimensions: DimensionScore[]
  findings: Finding[]
  ruleIssues: RuleIssue[]
  counts: SeverityCounts
}

const COUNTED_PER_RULE = 3

export function gradeOf(score: number): { grade: string; label: string } {
  if (score >= 90) return { grade: 'A', label: '优秀' }
  if (score >= 75) return { grade: 'B', label: '良好' }
  if (score >= 60) return { grade: 'C', label: '合格' }
  if (score >= 40) return { grade: 'D', label: '待修' }
  return { grade: 'E', label: '不可用' }
}

/** 等级标签用哪一条文案（字典键的后半段）。
 *
 *  有 error 级问题时总分封顶 74（ADR-0003），74 恰好是 C 的上沿，所以「有严重问题」的轨迹最高就是 C。
 *  C 的字面是「合格」，而规则自己的话可能是「判定为死循环，轨迹基本不可用」，同一份报告里两句话打架。
 *  所以：C 且带 error → `C.gated`（「有严重问题」）。字母与分数都不动——封顶是 ADR 定的，
 *  字母是给 CI 的契约。A/B 不可能带 error（封顶），D/E 的字面本来就是问题，都不需要特殊处理。 */
export function gradeKeyOf(card: { grade: string; counts: { error: number } }): string {
  return card.grade === 'C' && card.counts.error > 0 ? 'C.gated' : card.grade
}

export function capForErrors(distinctErrorRules: number): number {
  if (distinctErrorRules >= 5) return 39
  if (distinctErrorRules >= 3) return 54
  if (distinctErrorRules >= 1) return 74
  return 100
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (bySeverity !== 0) return bySeverity
    const aIndex = a.stepIndex ?? -1
    const bIndex = b.stepIndex ?? -1
    if (aIndex !== bIndex) return aIndex - bIndex
    return a.ruleId.localeCompare(b.ruleId)
  })
}

const MANUAL_IMPACT: Record<Severity, number> = { error: 8, warn: 5, info: 2 }

export function annotationFindings(trajectoryId: string, annotations: Annotation[]): Finding[] {
  return annotations
    .filter((annotation) => annotation.trajectoryId === trajectoryId && annotation.note.trim() !== '')
    .map((annotation) => ({
      id: `manual:${annotation.id}`,
      ruleId: 'manual',
      ruleTitle: '人工标注',
      dimension: annotation.dimension,
      severity: annotation.severity,
      message: annotation.note.trim(),
      stepIndex: annotation.stepIndex,
      impact: MANUAL_IMPACT[annotation.severity],
      manual: true,
    }))
}

export function scoreTrajectory(
  findings: Finding[],
  dimensions: Dimension[],
  ruleIssues: RuleIssue[] = [],
): ScoreCard {
  const totalWeight = dimensions.reduce((sum, dimension) => sum + Math.max(0, dimension.weight), 0)

  const dimensionScores: DimensionScore[] = dimensions.map((dimension) => {
    const scoped = findings.filter((finding) => finding.dimension === dimension.id)
    const counted = new Map<string, number>()
    let lost = 0
    for (const finding of scoped) {
      const used = counted.get(finding.ruleId) ?? 0
      if (used >= COUNTED_PER_RULE) continue
      counted.set(finding.ruleId, used + 1)
      lost += finding.impact
    }

    lost = Math.round(lost)
    return {
      id: dimension.id,
      label: dimension.label,
      color: dimension.color,
      weight: dimension.weight,
      score: Math.max(0, Math.min(100, 100 - lost)),
      lost,
      findings: scoped.length,
      errors: scoped.filter((finding) => finding.severity === 'error').length,
      warns: scoped.filter((finding) => finding.severity === 'warn').length,
    }
  })

  const mean =
    totalWeight > 0
      ? Math.round(
          dimensionScores.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0) /
            totalWeight,
        )
      : 100

  // Counts and the error gate only look at findings that land on a defined
  // dimension. A manual annotation whose dimension was dropped from the pack
  // must not keep gating the score — it stays visible in the findings list,
  // but it no longer decides the grade.
  const knownDimensions = new Set(dimensions.map((dimension) => dimension.id))
  const inScope = findings.filter((finding) => knownDimensions.has(finding.dimension))

  const counts: SeverityCounts = { error: 0, warn: 0, info: 0 }
  for (const finding of inScope) counts[finding.severity] += 1

  const distinctErrorRules = new Set(
    inScope.filter((finding) => finding.severity === 'error').map((finding) => finding.ruleId),
  ).size
  const overall = Math.min(mean, capForErrors(distinctErrorRules))
  const graded = gradeOf(overall)
  const gated = graded.grade === 'C' && counts.error > 0

  return {
    overall,
    rawOverall: mean,
    capped: overall < mean,
    grade: graded.grade,
    // core 的文案不本地化（已知边界）；界面与报告用 gradeKeyOf 查字典覆盖它，这里只是兜底。
    gradeLabel: gated ? '有严重问题' : graded.label,
    dimensions: dimensionScores,
    findings: sortFindings(findings),
    ruleIssues,
    counts,
  }
}
