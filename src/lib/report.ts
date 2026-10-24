/** 报告组装：Markdown（给人看）与 JSON（给机器看）。
 *
 *  双语边界：
 *  - Markdown 全量本地化（标题、表头、结论、时间格式）。
 *  - JSON 的**键名**是消费方契约，永不翻译；只有值的可读标签（gradeLabel、
 *    维度 label）随语言变化。CI 解析 JSON 不会因语言切换而断。
 *  - 规则包里的规则标题与提示属数据，任何语言下都保持原样。
 */

import { formatTokens } from '../core/estimate'
import { gradeKeyOf, type ScoreCard } from '../core/analysis'
import { alignSteps, compareCards, diffFindings, summarizeAlignment, type AlignStatus } from '../core/compare'
import { mdCell, mdInline } from './markdown'
import { buildAdvice } from '../core/rules/advice'
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

/** Every number the three artifacts show in their summary, computed once.
 *
 *  Markdown, JSON and HTML used to each run their own reduce over `entries`.
 *  They agreed only by discipline; this makes it structural. */
export interface ReportTotals {
  sessions: number
  steps: number
  tokens: number
  average: number
  /** Rules that actually ran — disabled ones are not part of the verdict. */
  enabledRules: number
}

export function reportTotals(entries: ReportEntry[], pack: RulePack): ReportTotals {
  const steps = entries.reduce((sum, entry) => sum + entry.trajectory.steps.length, 0)
  const tokens = entries.reduce((sum, entry) => sum + entry.trajectory.meta.totalTokens, 0)
  return {
    sessions: entries.length,
    steps,
    tokens,
    average:
      entries.length > 0
        ? Math.round(entries.reduce((sum, entry) => sum + entry.card.overall, 0) / entries.length)
        : 100,
    enabledRules: pack.rules.filter((rule) => rule.enabled !== false).length,
  }
}

const SEVERITY_KEY: Record<Severity, MessageKey> = {
  error: 'severity.error',
  warn: 'severity.warn',
  info: 'severity.info',
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
  const totals = reportTotals(entries, pack)

  lines.push(`- ${t('report.rulePack', { name: mdInline(pack.name), count: totals.enabledRules })}`)
  lines.push(`- ${t('report.sessionCount', { count: totals.sessions })}`)
  lines.push(`- ${t('report.totalSteps', { count: totals.steps })}`)
  lines.push(`- ${t('report.estimatedTokens', { tokens: formatTokens(totals.tokens) })}`)
  lines.push(`- ${t('report.average', { score: totals.average })}`)
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
      `| ${mdCell(trajectory.label)} | ${trajectory.steps.length} | ${formatTokens(
        trajectory.meta.totalTokens,
      )} | ${card.overall} | ${card.grade} | ${card.counts.error} | ${card.counts.warn} | ${card.counts.info} |`,
    )
  }
  lines.push('')

  entries.forEach(({ trajectory, card }, index) => {
    lines.push(`## ${index + 1}. ${mdInline(trajectory.label)}`)
    lines.push('')
    lines.push(
      `**${t('report.totalScore', {
        score: card.overall,
        grade: card.grade,
        label: labelFor(locale, 'grade', gradeKeyOf(card), card.gradeLabel),
      })}**`,
    )
    lines.push('')
    if (card.capped) {
      lines.push(`> ${t('report.cappedNote', { raw: card.rawOverall, score: card.overall })}`)
      lines.push('')
    }
    if (trajectory.meta.model) lines.push(`- ${t('report.model', { model: mdInline(trajectory.meta.model) })}`)
    if (trajectory.meta.estimatedTokens) lines.push(`- ${t('report.estimatedNote')}`)
    lines.push('')

    lines.push(
      `| ${t('report.dimensionHeader')} | ${t('report.dimensionScore')} | ${t('report.dimensionLost')} | ${t(
        'report.dimensionFindings',
      )} |`,
    )
    lines.push('| --- | ---: | ---: | ---: |')
    for (const dimension of card.dimensions) {
      const name = mdCell(labelFor(locale, 'dimension', dimension.id, dimension.label))
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
        `${findingIndex + 1}. **${severityText(t, finding.severity)}** · **${mdInline(finding.ruleTitle)}**${location}`,
      )
      lines.push(`   - ${t('report.detail', { text: mdCell(finding.message) })}`)
      if (finding.evidence) lines.push(`   - ${t('report.evidence', { text: mdCell(finding.evidence) })}`)
    })
    lines.push('')

    const advice = buildAdvice(card.findings, locale)
    if (advice.length > 0) {
      lines.push(`### ${t('report.advice')}`)
      lines.push('')
      advice.forEach((item, adviceIndex) => {
        // 只出现一次就不必标「1 处」——那是噪音。
        const suffix = item.count > 1 ? t('report.adviceSuffix', { text: t('report.adviceCount', { count: item.count }) }) : ''
        lines.push(`${adviceIndex + 1}. ${item.text}${suffix}`)
      })
      lines.push('')
    }
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
        lines.push(`- ${t('report.ruleIssueItem', { id: mdInline(issue.ruleId), message: mdInline(issue.message) })}`)
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
  const totals = reportTotals(entries, pack)
  return JSON.stringify(
    {
      generatedAt: generatedAt.toISOString(),
      locale,
      // `rules` 是规则总数（含停用的），键名是给 CI 的契约，含义不改；
      // Markdown / HTML 打印的「N 条启用」是 `enabledRules`，两个数字都给，读者不会再拿它们对不上。
      rulePack: {
        name: pack.name,
        version: pack.version,
        rules: pack.rules.length,
        enabledRules: totals.enabledRules,
      },
      // 与 Markdown / HTML 汇总行同一份 `reportTotals`：三种产物的数字在结构上不会分叉。
      totals,
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
        gradeLabel: labelFor(locale, 'grade', gradeKeyOf(card), card.gradeLabel),
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

// ---------- 轨迹对比 ----------

export interface ComparisonInput {
  base: ReportEntry
  target: ReportEntry
  generatedAt: Date
  locale: Locale
  /** 步骤差异最多写多少行，默认 40。 */
  maxStepRows?: number
}

const ALIGN_KEY: Record<AlignStatus, MessageKey> = {
  same: 'compare.status.same',
  changed: 'compare.status.changed',
  added: 'compare.status.added',
  removed: 'compare.status.removed',
}

function signed(value: number): string {
  if (value === 0) return '0'
  return value > 0 ? `+${value}` : String(value)
}

function clip(text: string, limit = 60): string {
  const flat = text.trim().replace(/\s+/g, ' ')
  const short = flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
  return mdCell(short)
}

function stepPreview(step: { text: string; toolCalls: { name: string }[] } | undefined): string {
  if (!step) return '—'
  if (step.text.trim()) return clip(step.text)
  if (step.toolCalls.length > 0) return mdCell(step.toolCalls.map((call) => call.name).join(', '))
  return '—'
}

/** The comparison, computed once and shared by the Markdown/JSON and the HTML
 *  artifact. Step alignment is an LCS over both trajectories; running it twice
 *  per export was pure waste. */
export function buildComparisonModel(input: ComparisonInput) {
  const cardDiff = compareCards(input.base, input.target)
  const findingDiff = diffFindings(input.base.card.findings, input.target.card.findings)
  const rows = alignSteps(input.base.trajectory.steps, input.target.trajectory.steps)
  return {
    cardDiff,
    findingDiff,
    rows,
    // 「哪些行算变化」与「最多写几行」只在这里定一次：Markdown 与 HTML 各算各的，
    // HTML 曾把上限写死成 40，调用方传的 maxStepRows 对它无效。
    changedRows: rows.filter((row) => row.status !== 'same'),
    stepLimit: input.maxStepRows ?? 40,
    summary: summarizeAlignment(rows),
  }
}

/** The comparison, computed once. Rendering takes it as an argument so a
 *  caller exporting several artifacts does not recompute it per artifact. */
export type ComparisonModel = ReturnType<typeof buildComparisonModel>

export function renderComparisonMarkdown(input: ComparisonInput, model: ComparisonModel): string {
  const t: Translate = (key, params) => translate(input.locale, key, params)
  const { cardDiff, findingDiff, changedRows, stepLimit, summary } = model
  const lines: string[] = []

  lines.push(`# ${t('report.compare.title')}`)
  lines.push('')
  lines.push(`- ${t('report.generatedAt', { time: formatDateTime(input.locale, input.generatedAt) })}`)
  lines.push(`- ${t('report.compare.base', { label: mdInline(input.base.trajectory.label) })}`)
  lines.push(`- ${t('report.compare.target', { label: mdInline(input.target.trajectory.label) })}`)
  lines.push('')

  lines.push(`## ${t('report.compare.scoreSection')}`)
  lines.push('')
  lines.push(
    `| ${t('report.compare.item')} | ${t('report.compare.baseColumn')} | ${t(
      'report.compare.targetColumn',
    )} | ${t('report.compare.delta')} |`,
  )
  lines.push('| --- | ---: | ---: | ---: |')
  lines.push(
    `| ${t('report.compare.total')} | ${cardDiff.overall.before} | ${cardDiff.overall.after} | ${signed(
      cardDiff.overall.delta,
    )} |`,
  )
  lines.push(`| ${t('report.compare.grade')} | ${cardDiff.grade.before} | ${cardDiff.grade.after} | — |`)
  lines.push(
    `| ${t('report.compare.steps')} | ${cardDiff.steps.before} | ${cardDiff.steps.after} | ${signed(
      cardDiff.steps.delta,
    )} |`,
  )
  lines.push(
    `| ${t('report.compare.tokens')} | ${cardDiff.tokens.before} | ${cardDiff.tokens.after} | ${signed(
      cardDiff.tokens.delta,
    )} |`,
  )
  lines.push('')

  lines.push(`## ${t('report.compare.dimensionSection')}`)
  lines.push('')
  lines.push(
    `| ${t('report.dimensionHeader')} | ${t('report.compare.baseColumn')} | ${t(
      'report.compare.targetColumn',
    )} | ${t('report.compare.delta')} |`,
  )
  lines.push('| --- | ---: | ---: | ---: |')
  for (const dimension of cardDiff.dimensions) {
    const name = mdCell(labelFor(input.locale, 'dimension', dimension.id, dimension.label))
    lines.push(`| ${name} | ${dimension.before} | ${dimension.after} | ${signed(dimension.delta)} |`)
  }
  lines.push('')

  lines.push(`## ${t('report.compare.findingsSection')}`)
  lines.push('')
  lines.push(
    t('report.compare.findingsSummary', {
      added: findingDiff.added.length,
      resolved: findingDiff.resolved.length,
      persisted: findingDiff.persisted.length,
    }),
  )
  lines.push('')

  const writeFindings = (title: string, items: typeof findingDiff.added) => {
    if (items.length === 0) return
    lines.push(`### ${title}`)
    lines.push('')
    items.forEach((finding, index) => {
      const location =
        finding.stepIndex !== undefined ? ` · ${t('report.stepAt', { index: finding.stepIndex + 1 })}` : ''
      lines.push(
        `${index + 1}. **${severityText(t, finding.severity)}** · **${mdInline(finding.ruleTitle)}**${location}`,
      )
      lines.push(`   - ${t('report.detail', { text: mdCell(finding.message) })}`)
    })
    lines.push('')
  }

  writeFindings(t('report.compare.addedSection'), findingDiff.added)
  writeFindings(t('report.compare.resolvedSection'), findingDiff.resolved)

  // 建议只针对「对照」新增的问题：基准已经修过的东西不必再提。
  const advice = buildAdvice(findingDiff.added, input.locale)
  if (advice.length > 0) {
    lines.push(`### ${t('report.compare.advice')}`)
    lines.push('')
    advice.forEach((item, adviceIndex) => {
      const suffix = item.count > 1 ? t('report.adviceSuffix', { text: t('report.adviceCount', { count: item.count }) }) : ''
      lines.push(`${adviceIndex + 1}. ${item.text}${suffix}`)
    })
    lines.push('')
  }

  lines.push(`## ${t('report.compare.stepsSection')}`)
  lines.push('')
  lines.push(
    `${summary.changed} ${t('compare.changed')} · ${summary.added + summary.removed} ${t('compare.structural')}`,
  )
  lines.push('')
  const limit = stepLimit
  const changed = changedRows
  if (changed.length === 0) {
    lines.push(t('report.compare.noDifferences'))
    lines.push('')
  } else {
    lines.push(
      `| ${t('report.compare.status')} | ${t('report.compare.baseStep')} | ${t('report.compare.targetStep')} | ${t(
        'report.compare.baseText',
      )} | ${t('report.compare.targetText')} |`,
    )
    lines.push('| --- | ---: | ---: | --- | --- |')
    for (const row of changed.slice(0, limit)) {
      lines.push(
        `| ${t(ALIGN_KEY[row.status])} | ${row.before ? row.before.index + 1 : '—'} | ${
          row.after ? row.after.index + 1 : '—'
        } | ${stepPreview(row.before)} | ${stepPreview(row.after)} |`,
      )
    }
    lines.push('')
    if (changed.length > limit) {
      lines.push(t('report.compare.truncated', { count: limit }))
      lines.push('')
    }
  }

  // 页脚讲评分口径，和 HTML 版、逐会话报告一致。此前这里把「问题变化」一节里的汇总行
  // 原样再印了一遍，评分口径在对比的 Markdown 里根本没出现过。
  lines.push('---')
  lines.push('')
  lines.push(t('report.footer'))
  lines.push('')

  return lines.join('\n')
}

export function renderComparisonJson(input: ComparisonInput, model: ComparisonModel): string {
  const { cardDiff, findingDiff, changedRows, summary } = model
  return JSON.stringify(
    {
      generatedAt: input.generatedAt.toISOString(),
      locale: input.locale,
      base: { id: input.base.trajectory.id, label: input.base.trajectory.label },
      target: { id: input.target.trajectory.id, label: input.target.trajectory.label },
      score: cardDiff,
      findings: {
        added: findingDiff.added.length,
        resolved: findingDiff.resolved.length,
        persisted: findingDiff.persisted.length,
        addedItems: findingDiff.added,
        resolvedItems: findingDiff.resolved,
      },
      steps: summary,
      // JSON 给机器读，不按 maxStepRows 截断：悄悄少几行，下游会以为变化更少。
      changedSteps: changedRows.map((row) => ({
        status: row.status,
        baseStep: row.before ? row.before.index + 1 : null,
        targetStep: row.after ? row.after.index + 1 : null,
      })),
    },
    null,
    2,
  )
}


/** Convenience wrappers: compute once, render one artifact. Callers that emit
 *  several artifacts should build the model themselves and pass it in. */
export function buildComparisonReport(input: ComparisonInput): string {
  return renderComparisonMarkdown(input, buildComparisonModel(input))
}

export function buildComparisonJson(input: ComparisonInput): string {
  return renderComparisonJson(input, buildComparisonModel(input))
}
