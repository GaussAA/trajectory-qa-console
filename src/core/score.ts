/** Scoring: turn findings into a per-dimension score and one overall grade.
 *
 *  Design choices worth knowing:
 *  - A repeated rule is capped at 3 counted occurrences. Otherwise one systemic
 *    issue (say, 40 unpaired calls) floors the score and hides everything else.
 *  - Every dimension floors at 0 and the overall score is a weighted mean, so
 *    adding a dimension never silently changes the scale.
 */

import type { Dimension, Finding, RuleIssue } from './rules'
import { SEVERITY_ORDER } from './rules'

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

export interface SeverityCounts {
  error: number
  warn: number
  info: number
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

/** A confirmed error is a release blocker, so it gates the headline score.
 *  We count *distinct error rules*, not occurrences: one systemic flaw found
 *  forty times is still one flaw, and occurrence counts already cost points
 *  inside its dimension. */
function capForErrors(distinctErrorRules: number): number {
  if (distinctErrorRules >= 5) return 39
  if (distinctErrorRules >= 3) return 54
  if (distinctErrorRules >= 1) return 74
  return 100
}

const COUNTED_PER_RULE = 3

export function gradeOf(score: number): { grade: string; label: string } {
  if (score >= 90) return { grade: 'A', label: '优秀' }
  if (score >= 75) return { grade: 'B', label: '良好' }
  if (score >= 60) return { grade: 'C', label: '合格' }
  if (score >= 40) return { grade: 'D', label: '待修' }
  return { grade: 'E', label: '不可用' }
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

  const overall =
    totalWeight > 0
      ? Math.round(
          dimensionScores.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0) /
            totalWeight,
        )
      : 100

  const counts: SeverityCounts = { error: 0, warn: 0, info: 0 }
  for (const finding of findings) counts[finding.severity] += 1

  const distinctErrorRules = new Set(
    findings.filter((finding) => finding.severity === 'error').map((finding) => finding.ruleId),
  ).size
  const capped = Math.min(overall, capForErrors(distinctErrorRules))
  const graded = gradeOf(capped)

  return {
    overall: capped,
    rawOverall: overall,
    capped: capped < overall,
    grade: graded.grade,
    gradeLabel: graded.label,
    dimensions: dimensionScores,
    findings: sortFindings(findings),
    ruleIssues,
    counts,
  }
}

/** Aggregate several session cards into one headline number, weighted by steps. */
export function aggregateScore(
  entries: { card: ScoreCard; weight: number }[],
): { overall: number; grade: string; gradeLabel: string; counts: SeverityCounts } {
  const totalWeight = entries.reduce((sum, entry) => sum + Math.max(1, entry.weight), 0)
  const overall =
    entries.length === 0
      ? 100
      : Math.round(
          entries.reduce((sum, entry) => sum + entry.card.overall * Math.max(1, entry.weight), 0) /
            totalWeight,
        )
  const { grade, label } = gradeOf(overall)
  const counts: SeverityCounts = { error: 0, warn: 0, info: 0 }
  for (const entry of entries) {
    for (const finding of entry.card.findings) counts[finding.severity] += 1
  }
  return { overall, grade, gradeLabel: label, counts }
}
