/** 单文件 HTML 报告：双击即看，可直接发给不看命令行的人。
 *
 *  三条硬约束：
 *  1. 自包含 —— 没有外部字体、样式、脚本，断网也能完整显示；
 *  2. 零脚本 —— 只用 `<details>` 做折叠，避免在别人的浏览器里执行任何代码；
 *  3. 全量转义 —— 轨迹名、工具名、模型输出都来自外部数据，必须当不可信内容处理。
 *
 *  视觉沿用应用的设计令牌（深色液态玻璃），并在 `@media print` 下翻成浅色，
 *  这样「发给同事」和「打印/存 PDF」两种用法都不难看。
 */

import { formatTokens } from '../core/estimate'
import type { ScoreCard } from '../core/analysis'
import { buildAdvice } from '../core/rules/advice'
import type { Severity } from '../core/model'
import {
  formatDateTime,
  labelFor,
  translate,
  type Locale,
  type MessageKey,
  type Translate,
} from '../i18n/core'
import { reportTotals, type ReportEntry, type ReportInput } from './report'
import { STYLE, clampPercent, escapeHtml, toneOf } from './report-style'

const SEVERITY_KEY: Record<Severity, MessageKey> = {
  error: 'severity.error',
  warn: 'severity.warn',
  info: 'severity.info',
}

function severityText(t: Translate, severity: Severity): string {
  return t(SEVERITY_KEY[severity])
}

function renderFindings(entry: ReportEntry, t: Translate): string {
  const { card } = entry
  if (card.findings.length === 0) return `<p class="empty">${escapeHtml(t('report.noFindings'))}</p>`

  const items = card.findings
    .map((finding) => {
      const location =
        finding.stepIndex !== undefined
          ? `<span class="chip">${escapeHtml(t('report.stepAt', { index: finding.stepIndex + 1 }))}</span>`
          : ''
      const evidence = finding.evidence ? `<pre class="evidence">${escapeHtml(finding.evidence)}</pre>` : ''
      return `<li class="finding sev-${finding.severity}">
        <div class="finding-head">
          <span class="sev">${escapeHtml(severityText(t, finding.severity))}</span>
          <span class="rule">${escapeHtml(finding.ruleTitle)}</span>
          ${location}
        </div>
        <p class="finding-body">${escapeHtml(finding.message)}</p>
        ${evidence}
      </li>`
    })
    .join('\n')

  return `<h3>${escapeHtml(t('report.findings'))}</h3><ul class="findings">${items}</ul>`
}

function renderAdvice(entry: ReportEntry, t: Translate, locale: Locale): string {
  const advice = buildAdvice(entry.card.findings, locale)
  if (advice.length === 0) return ''
  const items = advice
    .map((item) => {
      const count =
        item.count > 1
          ? `<span class="chip">${escapeHtml(t('report.adviceCount', { count: item.count }))}</span>`
          : ''
      return `<li>${escapeHtml(item.text)}${count}</li>`
    })
    .join('\n')
  return `<h3>${escapeHtml(t('report.advice'))}</h3><ol class="advice">${items}</ol>`
}

function renderDimensions(card: ScoreCard, t: Translate, locale: Locale): string {
  const rows = card.dimensions
    .map((dimension) => {
      const name = labelFor(locale, 'dimension', dimension.id, dimension.label)
      const tone = toneOf(dimension.score)
      return `<div class="dim">
        <span class="dim-name">${escapeHtml(name)}</span>
        <span class="dim-bar"><i style="width:${clampPercent(dimension.score)}%;background:${tone}"></i></span>
        <span class="dim-score">${dimension.score}</span>
        <span class="dim-lost">−${dimension.lost}</span>
      </div>`
    })
    .join('\n')
  return `<div class="dims" aria-label="${escapeHtml(t('report.dimensionHeader'))}">${rows}</div>`
}

function renderSession(entry: ReportEntry, index: number, t: Translate, locale: Locale): string {
  const { trajectory, card } = entry
  const tone = toneOf(card.overall)
  const gradeLabel = labelFor(locale, 'grade', card.grade, card.gradeLabel)
  const model = trajectory.meta.model
    ? `<span class="chip">${escapeHtml(t('report.model', { model: trajectory.meta.model }))}</span>`
    : ''
  const estimated = trajectory.meta.estimatedTokens
    ? `<span class="chip">${escapeHtml(t('report.estimatedNote'))}</span>`
    : ''
  const capped = card.capped
    ? `<p class="note">${escapeHtml(
        t('report.cappedNote', { raw: card.rawOverall, score: card.overall }),
      )}</p>`
    : ''

  return `<article class="session">
    <header class="session-head">
      <div class="session-title">
        <p class="eyebrow">${escapeHtml(t('report.sessionHeader'))} ${index + 1}</p>
        <h2>${escapeHtml(trajectory.label)}</h2>
        <div class="chips">
          <span class="chip">${escapeHtml(t('score.stepUnit', { count: trajectory.steps.length }))}</span>
          <span class="chip">${formatTokens(trajectory.meta.totalTokens)} ${escapeHtml(t('kpi.tokens'))}</span>
          ${model}
          ${estimated}
        </div>
      </div>
      <div class="score" style="--pct:${clampPercent(card.overall)};--tone:${tone}">
        <b>${card.overall}</b>
        <em>${escapeHtml(card.grade)} · ${escapeHtml(gradeLabel)}</em>
      </div>
    </header>
    ${capped}
    ${renderDimensions(card, t, locale)}
    ${renderFindings(entry, t)}
    ${renderAdvice(entry, t, locale)}
  </article>`
}

function renderRuleIssues(entries: ReportEntry[], t: Translate): string {
  const seen = new Set<string>()
  const items: string[] = []
  for (const { card } of entries) {
    for (const issue of card.ruleIssues) {
      const key = `${issue.ruleId}:${issue.message}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push(`<li><code>${escapeHtml(issue.ruleId)}</code> ${escapeHtml(issue.message)}</li>`)
    }
  }
  if (items.length === 0) return ''
  return `<section class="block"><h2>${escapeHtml(t('report.ruleIssues'))}</h2><ul class="issues">${items.join(
    '\n',
  )}</ul></section>`
}

export function buildHtmlReport({ entries, pack, generatedAt, locale }: ReportInput): string {
  const t: Translate = (key, params) => translate(locale, key, params)

  const totals = reportTotals(entries, pack)
  const { steps: totalSteps, tokens: totalTokens, average, enabledRules: ruleCount } = totals

  const overviewRows = entries
    .map(({ trajectory, card }) => {
      const tone = toneOf(card.overall)
      return `<tr>
        <td class="name">${escapeHtml(trajectory.label)}</td>
        <td class="num">${trajectory.steps.length}</td>
        <td class="num">${formatTokens(trajectory.meta.totalTokens)}</td>
        <td class="num" style="color:${tone};font-weight:600">${card.overall}</td>
        <td class="num">${escapeHtml(card.grade)}</td>
        <td class="num">${card.counts.error}</td>
        <td class="num">${card.counts.warn}</td>
        <td class="num">${card.counts.info}</td>
      </tr>`
    })
    .join('\n')

  const sessions = entries.map((entry, index) => renderSession(entry, index, t, locale)).join('\n')

  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(t('report.title'))} · ${escapeHtml(formatDateTime(locale, generatedAt))}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="page">
  <header class="masthead">
    <div>
      <p class="eyebrow">Trajectory QA Console</p>
      <h1>${escapeHtml(t('report.title'))}</h1>
      <p class="meta">${escapeHtml(t('report.generatedAt', { time: formatDateTime(locale, generatedAt) }))}</p>
      <p class="meta">${escapeHtml(t('report.rulePack', { name: pack.name, count: ruleCount }))}</p>
    </div>
  </header>

  <section class="kpis">
    <div class="kpi"><span>${escapeHtml(t('kpi.sessions'))}</span><b>${entries.length}</b></div>
    <div class="kpi"><span>${escapeHtml(t('kpi.steps'))}</span><b>${totalSteps}</b></div>
    <div class="kpi"><span>${escapeHtml(t('kpi.tokens'))}</span><b>${formatTokens(totalTokens)}</b></div>
    <div class="kpi"><span>${escapeHtml(t('kpi.average'))}</span><b>${average}</b></div>
  </section>

  <section class="block">
    <h2>${escapeHtml(t('report.overview'))}</h2>
    <table>
      <thead>
        <tr>
          <th>${escapeHtml(t('report.sessionHeader'))}</th>
          <th class="num">${escapeHtml(t('report.stepsHeader'))}</th>
          <th class="num">${escapeHtml(t('report.tokenHeader'))}</th>
          <th class="num">${escapeHtml(t('report.scoreHeader'))}</th>
          <th class="num">${escapeHtml(t('report.gradeHeader'))}</th>
          <th class="num">${escapeHtml(t('severity.error'))}</th>
          <th class="num">${escapeHtml(t('severity.warn'))}</th>
          <th class="num">${escapeHtml(t('severity.info'))}</th>
        </tr>
      </thead>
      <tbody>
${overviewRows}
      </tbody>
    </table>
  </section>

${sessions}

  ${renderRuleIssues(entries, t)}

  <footer>${escapeHtml(t('report.footer'))}</footer>
</div>
</body>
</html>
`
}
