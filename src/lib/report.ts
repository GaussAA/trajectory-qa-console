/** 报告组装：Markdown（给人看）与 JSON（给机器看）。
 *
 *  双语边界：
 *  - Markdown 全量本地化（标题、表头、结论、时间格式）。
 *  - JSON 的**键名**是消费方契约，永不翻译；只有值的可读标签（gradeLabel、
 *    维度 label）随语言变化。CI 解析 JSON 不会因语言切换而断。
 *  - 规则包里的规则标题与提示属数据，任何语言下都保持原样。
 */

import { formatTokens } from '../core/estimate'
import type { ScoreCard } from '../core/analysis'
import type { RulePack, Severity, Trajectory } from '../core/model'
import {
  formatDateTime,
  labelFor,
  translate,
  type Locale,
  type MessageKey,
  type Translate,
} from '../i18n/core'

/** One session's report material. Passing entries — not two collections keyed by
 *  an id — removes the chance of the card and the trajectory drifting apart. */
export interface ReportEntry {
  trajectory: Trajectory
  card: ScoreCard
}

export interface ReportInput {
  entries: ReportEntry[]
  pack: RulePack
  generatedAt: Date
  locale: Locale
}

const SEVERITY_KEY: Record<Severity, MessageKey> = {
  error: 'severity.error',
  warn: 'severity.warn',
  info: 'severity.info',
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ')
}

function severityText(t: Translate, severity: Severity): string {
  const key = SEVERITY_KEY[severity]
  return key ? t(key) : severity
}

export function buildMarkdownReport({ entries, pack, generatedAt, locale }: ReportInput): string {
  const t: Translate = (key, params) => translate(locale, key, params)
  const lines: string[] = []

  lines.push(`# ${t('report.title')}`)
  lines.push('')
  lines.push(`- ${t('report.generatedAt', { time: formatDateTime(locale, generatedAt) })}`)
  lines.push(
    `- ${t('report.rulePack', {
      name: pack.name,
      count: pack.rules.filter((rule) => rule.enabled !== false).length,
    })}`,
  )
  lines.push(`- ${t('report.sessionCount', { count: entries.length })}`)

  const totalSteps = entries.reduce((sum, entry) => sum + entry.trajectory.steps.length, 0)
  const totalTokens = entries.reduce((sum, entry) => sum + entry.trajectory.meta.totalTokens, 0)
  const average =
    entries.length > 0
      ? Math.round(entries.reduce((sum, entry) => sum + entry.card.overall, 0) / entries.length)
      : 100

  lines.push(`- ${t('report.totalSteps', { count: totalSteps })}`)
  lines.push(`- ${t('report.estimatedTokens', { tokens: formatTokens(totalTokens) })}`)
  lines.push(`- ${t('report.average', { score: average })}`)
  lines.push('')

  lines.push(`## ${t('report.overview')}`)
  lines.push('')
  lines.push(
    `| ${t('report.sessionHeader')} | ${t('report.stepsHeader')} | ${t('report.tokenHeader')} | ${t(
      'report.scoreHeader',
    )} | ${t('report.gradeHeader')} | ${t('severity.error')} | ${t('severity.warn')} | ${t('severity.info')} |`,
  )
  lines.push('| --- | ---: | ---: | ---: | :---: | ---: | ---: | ---: |')
  for (const { trajectory, card } of entries) {
    lines.push(
      `| ${escapeCell(trajectory.label)} | ${trajectory.steps.length} | ${formatTokens(
        trajectory.meta.totalTokens,
      )} | ${card.overall} | ${card.grade} | ${card.counts.error} | ${card.counts.warn} | ${card.counts.info} |`,
    )
  }
  lines.push('')

  entries.forEach(({ trajectory, card }, index) => {
    lines.push(`## ${index + 1}. ${trajectory.label}`)
    lines.push('')
    lines.push(
      `**${t('report.totalScore', {
        score: card.overall,
        grade: card.grade,
        label: labelFor(locale, 'grade', card.grade, card.gradeLabel),
      })}**`,
    )
    lines.push('')
    if (card.capped) {
      lines.push(`> ${t('report.cappedNote', { raw: card.rawOverall, score: card.overall })}`)
      lines.push('')
    }
    if (trajectory.meta.model) lines.push(`- ${t('report.model', { model: trajectory.meta.model })}`)
    if (trajectory.meta.estimatedTokens) lines.push(`- ${t('report.estimatedNote')}`)
    lines.push('')

    lines.push(
      `| ${t('report.dimensionHeader')} | ${t('report.dimensionScore')} | ${t('report.dimensionLost')} | ${t(
        'report.dimensionFindings',
      )} |`,
    )
    lines.push('| --- | ---: | ---: | ---: |')
    for (const dimension of card.dimensions) {
      const name = labelFor(locale, 'dimension', dimension.id, dimension.label)
      lines.push(`| ${name} | ${dimension.score} | ${dimension.lost} | ${dimension.findings} |`)
    }
    lines.push('')

    if (card.findings.length === 0) {
      lines.push(t('report.noFindings'))
      lines.push('')
      return
    }

    lines.push(`### ${t('report.findings')}`)
    lines.push('')
    card.findings.forEach((finding, findingIndex) => {
      const location =
        finding.stepIndex !== undefined ? ` · ${t('report.stepAt', { index: finding.stepIndex + 1 })}` : ''
      lines.push(
        `${findingIndex + 1}. **${severityText(t, finding.severity)}** · **${finding.ruleTitle}**${location}`,
      )
      lines.push(`   - ${t('report.detail', { text: escapeCell(finding.message) })}`)
      if (finding.evidence) lines.push(`   - ${t('report.evidence', { text: escapeCell(finding.evidence) })}`)
    })
    lines.push('')
  })

  if (entries.some((entry) => entry.card.ruleIssues.length > 0)) {
    lines.push(`## ${t('report.ruleIssues')}`)
    lines.push('')
    const seen = new Set<string>()
    for (const { card } of entries) {
      for (const issue of card.ruleIssues) {
        const key = `${issue.ruleId}:${issue.message}`
        if (seen.has(key)) continue
        seen.add(key)
        lines.push(`- ${t('report.ruleIssueItem', { id: issue.ruleId, message: issue.message })}`)
      }
    }
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push(t('report.footer'))
  lines.push('')

  return lines.join('\n')
}

export function buildJsonReport({ entries, pack, generatedAt, locale }: ReportInput): string {
  return JSON.stringify(
    {
      generatedAt: generatedAt.toISOString(),
      locale,
      rulePack: { name: pack.name, version: pack.version, rules: pack.rules.length },
      sessions: entries.map(({ trajectory, card }) => ({
        id: trajectory.id,
        label: trajectory.label,
        source: trajectory.source,
        steps: trajectory.steps.length,
        tokens: trajectory.meta.totalTokens,
        estimatedTokens: trajectory.meta.estimatedTokens,
        score: card.overall,
        rawScore: card.rawOverall,
        grade: card.grade,
        gradeLabel: labelFor(locale, 'grade', card.grade, card.gradeLabel),
        dimensions: card.dimensions.map((dimension) => ({
          ...dimension,
          label: labelFor(locale, 'dimension', dimension.id, dimension.label),
        })),
        counts: card.counts,
        findings: card.findings,
        ruleIssues: card.ruleIssues,
        parseNotes: trajectory.parseNotes,
      })),
    },
    null,
    2,
  )
}
