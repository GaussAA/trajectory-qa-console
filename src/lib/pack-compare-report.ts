/** 口径对比的报告出口：Markdown 给人看，JSON 给机器看。
 *
 *  与 `core/compare/packs` 同源——这里只负责排版，数字不出现第二个版本。
 *  独立成文件而不是塞进逐会话报告：口径对比有自己的基准/对照前提，
 *  混进主报告会让「这份报告的分数是哪套口径算的」变成猜谜。
 */

import { comparePacks, type PackCompareSession, type PackComparison } from '../core/compare/packs'
import { formatDateTime, translate, type Locale, type MessageKey } from '../i18n/core'
import type { RulePack } from '../core/model'
import { mdCell, mdInline } from './markdown'

export interface PackCompareSide {
  name: string
  pack: RulePack
}

export interface PackCompareReportInput {
  sessions: PackCompareSession[]
  base: PackCompareSide
  target: PackCompareSide
  generatedAt: Date
  locale: Locale
}

export interface PackCompareReport {
  markdown: string
  json: string
}

/** The comparison, computed once and shared by both artifacts.
 *
 *  `comparePacks` re-runs every rule under both packs for every session, so
 *  calling it twice per export was pure waste — the same mistake the
 *  trace-comparison report had already made. */
export function buildPackCompareModel(input: PackCompareReportInput): PackComparison {
  return comparePacks(input.sessions, input.base.pack, input.target.pack)
}

export function renderPackCompareMarkdown(input: PackCompareReportInput, comparison: PackComparison): string {
  const t: Translate = (key, params) => translate(input.locale, key, params)

  const lines: string[] = []
  lines.push(`# ${t('report.packCompare.title')}`)
  lines.push('')
  lines.push(`- ${t('report.generatedAt', { time: formatDateTime(input.locale, input.generatedAt) })}`)
  lines.push(`- ${t('report.packCompare.base', { name: mdInline(input.base.name) })}`)
  lines.push(`- ${t('report.packCompare.target', { name: mdInline(input.target.name) })}`)
  lines.push('')

  if (comparison.identical) {
    lines.push(t('packcmp.same'))
    lines.push('')
    return lines.join('\n')
  }

  lines.push(
    `| ${t('report.sessionHeader')} | ${t('report.compare.baseColumn')} | ${t(
      'report.compare.targetColumn',
    )} | ${t('packcmp.delta')} |`,
  )
  lines.push('| --- | ---: | ---: | ---: |')
  for (const row of comparison.rows) {
    const delta = row.delta > 0 ? `+${row.delta}` : String(row.delta)
    lines.push(`| ${mdCell(row.label)} | ${row.base} | ${row.target} | ${delta} |`)
  }
  const avgDelta = comparison.targetAverage - comparison.baseAverage
  lines.push(
    `| **${t('packcmp.average')}** | **${comparison.baseAverage}** | **${comparison.targetAverage}** | **${
      avgDelta > 0 ? `+${avgDelta}` : String(avgDelta)
    }** |`,
  )
  lines.push('')
  return lines.join('\n')
}

export function renderPackCompareJson(input: PackCompareReportInput, comparison: PackComparison): string {
  return JSON.stringify(
    {
      generatedAt: input.generatedAt.toISOString(),
      locale: input.locale,
      base: { name: input.base.name, rules: input.base.pack.rules.length },
      target: { name: input.target.name, rules: input.target.pack.rules.length },
      identical: comparison.identical,
      sessions: comparison.rows,
      average: {
        base: comparison.baseAverage,
        target: comparison.targetAverage,
        delta: comparison.targetAverage - comparison.baseAverage,
      },
    },
    null,
    2,
  )
}

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

export function buildPackCompareMarkdown(input: PackCompareReportInput): string {
  return renderPackCompareMarkdown(input, buildPackCompareModel(input))
}

export function buildPackCompareJson(input: PackCompareReportInput): string {
  return renderPackCompareJson(input, buildPackCompareModel(input))
}
