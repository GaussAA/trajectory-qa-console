/** 对比报告的 HTML 形态：与逐会话报告共用同一套视觉与转义工具。
 *
 *  数据全部来自 `core/compare`（与对比视图、Markdown 对比报告同一份 diff），
 *  这里只负责把它画出来——数字不会出现第二个版本。
 */

import type { AlignedStep } from '../core/compare'
import { formatTokens } from '../core/estimate'
import { buildAdvice } from '../core/rules/advice'
import type { Severity } from '../core/model'
import { formatDateTime, labelFor, translate, type MessageKey, type Translate } from '../i18n/core'
import { buildComparisonModel, type ComparisonInput } from './report'
import { STYLE, clampPercent, escapeHtml, toneOf } from './report-style'

const SEVERITY_KEY: Record<Severity, MessageKey> = {
  error: 'severity.error',
  warn: 'severity.warn',
  info: 'severity.info',
}

const STATUS_KEY: Record<AlignedStep['status'], MessageKey> = {
  same: 'compare.status.same',
  changed: 'compare.status.changed',
  added: 'compare.status.added',
  removed: 'compare.status.removed',
}

function signed(value: number): string {
  if (value === 0) return '0'
  return value > 0 ? `+${value}` : String(value)
}

function deltaClass(value: number): string {
  if (value > 0) return 'up'
  if (value < 0) return 'down'
  return 'flat'
}

/** 分数上涨是好事（绿），下降是坏事（红）；与等级语义一致。 */
function deltaTone(value: number): string {
  if (value > 0) return '#34d399'
  if (value < 0) return '#fb7185'
  return 'var(--mute)'
}

function clip(text: string, limit = 60): string {
  const flat = text.trim().replace(/\s+/g, ' ')
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

function severityText(t: Translate, severity: Severity): string {
  return t(SEVERITY_KEY[severity])
}

function ring(score: number, label: string): string {
  return `<div class="score" style="--pct:${clampPercent(score)};--tone:${toneOf(score)}">
        <b>${score}</b>
        <em>${escapeHtml(label)}</em>
      </div>`
}

function renderFindings(
  title: string,
  findings: ComparisonInput['base']['card']['findings'],
  tone: 'added' | 'resolved',
  t: Translate,
): string {
  if (findings.length === 0) return ''
  const items = findings
    .map((finding) => {
      const location =
        finding.stepIndex !== undefined
          ? `<span class="chip">${escapeHtml(t('report.stepAt', { index: finding.stepIndex + 1 }))}</span>`
          : ''
      return `<li class="finding ${tone === 'added' ? `sev-${finding.severity}` : 'resolved'}">
        <div class="finding-head">
          <span class="sev">${escapeHtml(severityText(t, finding.severity))}</span>
          <span class="rule">${escapeHtml(finding.ruleTitle)}</span>
          ${location}
        </div>
        <p class="finding-body">${escapeHtml(finding.message)}</p>
      </li>`
    })
    .join('\n')
  return `<h3>${escapeHtml(title)}</h3><ul class="findings">${items}</ul>`
}

function renderStepRows(rows: AlignedStep[], t: Translate): string {
  return rows
    .map((row) => {
      const baseStep = row.before ? row.before.index + 1 : '—'
      const targetStep = row.after ? row.after.index + 1 : '—'
      const baseText = row.before
        ? row.before.text.trim() || row.before.toolCalls.map((call) => call.name).join(', ') || '—'
        : '—'
      const targetText = row.after
        ? row.after.text.trim() || row.after.toolCalls.map((call) => call.name).join(', ') || '—'
        : '—'
      return `<tr class="step-row st-${row.status}">
        <td><span class="status st-${row.status}">${escapeHtml(t(STATUS_KEY[row.status]))}</span></td>
        <td class="num">${baseStep}</td>
        <td class="num">${targetStep}</td>
        <td>${escapeHtml(clip(baseText))}</td>
        <td>${escapeHtml(clip(targetText))}</td>
      </tr>`
    })
    .join('\n')
}

const COMPARE_STYLE = `
.versus {
  display: flex;
  flex-wrap: wrap;
  gap: 22px;
  align-items: center;
  justify-content: center;
  padding: 6px 0 2px;
}
.versus .side { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.versus .side-label {
  max-width: 260px;
  font-size: 12px;
  color: var(--dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.versus .arrow { font-size: 22px; color: var(--mute); }
.delta-badge {
  font-size: 30px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.delta-badge.up { color: #34d399; }
.delta-badge.down { color: #fb7185; }
.delta-badge.flat { color: var(--mute); }
td .num, .delta-cell { font-variant-numeric: tabular-nums; }
.delta-cell { font-weight: 600; }
.status {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10.5px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  color: var(--mute);
}
.st-added .status { color: #5eead4; border-color: rgba(94, 234, 212, 0.32); background: rgba(94, 234, 212, 0.07); }
.st-removed .status { color: #fda4af; border-color: rgba(251, 113, 133, 0.3); background: rgba(251, 113, 133, 0.06); }
.st-changed .status { color: #fcd34d; border-color: rgba(251, 191, 36, 0.28); background: rgba(251, 191, 36, 0.06); }
.finding.resolved { border-left-color: #34d399; background: rgba(52, 211, 153, 0.05); }
.finding.resolved .sev { color: #6ee7b7; }
@media print {
  .versus .side-label, .status { color: #374151; }
  .st-added .status { color: #0f766e; border-color: #a7f3d0; background: #ecfdf5; }
  .st-removed .status { color: #b91c1c; border-color: #fecaca; background: #fef2f2; }
  .st-changed .status { color: #92400e; border-color: #fde68a; background: #fffbeb; }
  .finding.resolved { background: #f0fdf4; border-left-color: #059669; }
  .delta-badge.up { color: #047857; }
  .delta-badge.down { color: #be123c; }
  .delta-badge.flat { color: #4b5563; }
}
`

export function buildComparisonHtml(input: ComparisonInput): string {
  const t: Translate = (key, params) => translate(input.locale, key, params)
  const { base, target, generatedAt, locale } = input

  const { cardDiff, findingDiff, rows, summary } = buildComparisonModel(input)

  const dimensionRows = cardDiff.dimensions
    .map((dimension) => {
      const name = labelFor(locale, 'dimension', dimension.id, dimension.label)
      const tone = deltaTone(dimension.delta)
      return `<tr>
        <td class="name">${escapeHtml(name)}</td>
        <td class="num">${dimension.before}</td>
        <td class="num">${dimension.after}</td>
        <td class="num delta-cell" style="color:${tone}">${signed(dimension.delta)}</td>
      </tr>`
    })
    .join('\n')

  const advice = buildAdvice(findingDiff.added, locale)
  const adviceHtml =
    advice.length > 0
      ? `<h3>${escapeHtml(t('report.compare.advice'))}</h3><ol class="advice">${advice
          .map((item) => {
            const count =
              item.count > 1
                ? `<span class="chip">${escapeHtml(t('report.adviceCount', { count: item.count }))}</span>`
                : ''
            return `<li>${escapeHtml(item.text)}${count}</li>`
          })
          .join('\n')}</ol>`
      : ''

  const changedRows = rows.filter((row) => row.status !== 'same')
  const limit = 40
  const stepsSection =
    changedRows.length === 0
      ? `<p class="empty">${escapeHtml(t('report.compare.noDifferences'))}</p>`
      : `<table>
      <thead>
        <tr>
          <th>${escapeHtml(t('report.compare.status'))}</th>
          <th class="num">${escapeHtml(t('report.compare.baseStep'))}</th>
          <th class="num">${escapeHtml(t('report.compare.targetStep'))}</th>
          <th>${escapeHtml(t('report.compare.baseText'))}</th>
          <th>${escapeHtml(t('report.compare.targetText'))}</th>
        </tr>
      </thead>
      <tbody>
${renderStepRows(changedRows.slice(0, limit), t)}
      </tbody>
    </table>
    ${
      changedRows.length > limit
        ? `<p class="note">${escapeHtml(t('report.compare.truncated', { count: limit }))}</p>`
        : ''
    }`

  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(t('report.compare.title'))} · ${escapeHtml(formatDateTime(locale, generatedAt))}</title>
<style>${STYLE}${COMPARE_STYLE}</style>
</head>
<body>
<div class="page">
  <header class="masthead">
    <div>
      <p class="eyebrow">Trajectory QA Console</p>
      <h1>${escapeHtml(t('report.compare.title'))}</h1>
      <p class="meta">${escapeHtml(t('report.generatedAt', { time: formatDateTime(locale, generatedAt) }))}</p>
      <p class="meta">
        ${escapeHtml(t('report.compare.base', { label: base.trajectory.label }))} →
        ${escapeHtml(t('report.compare.target', { label: target.trajectory.label }))}
      </p>
    </div>
  </header>

  <section class="block">
    <div class="versus">
      <div class="side">
        ${ring(cardDiff.overall.before, cardDiff.grade.before)}
        <span class="side-label" title="${escapeHtml(base.trajectory.label)}">${escapeHtml(
          base.trajectory.label,
        )}</span>
      </div>
      <span class="delta-badge ${deltaClass(cardDiff.overall.delta)}">${signed(cardDiff.overall.delta)}</span>
      <div class="side">
        ${ring(cardDiff.overall.after, cardDiff.grade.after)}
        <span class="side-label" title="${escapeHtml(target.trajectory.label)}">${escapeHtml(
          target.trajectory.label,
        )}</span>
      </div>
    </div>
    <div class="dims">
      <div class="dim"><span class="dim-name">${escapeHtml(t('report.compare.steps'))}</span><span></span><span class="dim-score">${cardDiff.steps.before} → ${cardDiff.steps.after}</span><span class="dim-lost">${signed(cardDiff.steps.delta)}</span></div>
      <div class="dim"><span class="dim-name">${escapeHtml(t('report.compare.tokens'))}</span><span></span><span class="dim-score">${formatTokens(cardDiff.tokens.before)} → ${formatTokens(cardDiff.tokens.after)}</span><span class="dim-lost">${signed(cardDiff.tokens.delta)}</span></div>
    </div>
  </section>

  <section class="block">
    <h2>${escapeHtml(t('report.compare.dimensionSection'))}</h2>
    <table>
      <thead>
        <tr>
          <th>${escapeHtml(t('report.dimensionHeader'))}</th>
          <th class="num">${escapeHtml(t('report.compare.baseColumn'))}</th>
          <th class="num">${escapeHtml(t('report.compare.targetColumn'))}</th>
          <th class="num">${escapeHtml(t('report.compare.delta'))}</th>
        </tr>
      </thead>
      <tbody>
${dimensionRows}
      </tbody>
    </table>
  </section>

  <section class="block">
    <h2>${escapeHtml(t('report.compare.findingsSection'))}</h2>
    <p class="meta">${escapeHtml(
      t('report.compare.findingsSummary', {
        added: findingDiff.added.length,
        resolved: findingDiff.resolved.length,
        persisted: findingDiff.persisted.length,
      }),
    )}</p>
    ${renderFindings(t('report.compare.addedSection'), findingDiff.added, 'added', t)}
    ${renderFindings(t('report.compare.resolvedSection'), findingDiff.resolved, 'resolved', t)}
    ${adviceHtml}
  </section>

  <section class="block">
    <h2>${escapeHtml(t('report.compare.stepsSection'))}</h2>
    <p class="meta">${summary.changed} ${escapeHtml(t('compare.changed'))} · ${
      summary.added + summary.removed
    } ${escapeHtml(t('compare.structural'))}</p>
    ${stepsSection}
  </section>

  <footer>${escapeHtml(t('report.footer'))}</footer>
</div>
</body>
</html>
`
}
