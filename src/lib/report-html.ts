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
import type { ReportEntry, ReportInput } from './report'

const SEVERITY_KEY: Record<Severity, MessageKey> = {
  error: 'severity.error',
  warn: 'severity.warn',
  info: 'severity.info',
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 分数决定强调色：跟应用里的等级语义保持一致。 */
function toneOf(score: number): string {
  if (score >= 90) return '#5eead4'
  if (score >= 75) return '#34d399'
  if (score >= 60) return '#fbbf24'
  return '#fb7185'
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

function clampPercent(score: number): number {
  if (!Number.isFinite(score)) return 0
  return Math.max(0, Math.min(100, Math.round(score)))
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

const STYLE = `
:root {
  color-scheme: dark;
  --bg: #06080f;
  --panel: rgba(19, 25, 40, 0.56);
  --line: rgba(148, 163, 184, 0.12);
  --text: #e9eef8;
  --dim: #a8b3c7;
  --mute: #6f7a92;
  --mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'HarmonyOS Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 40px 24px 64px;
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.6;
  color: var(--text);
  background:
    radial-gradient(900px 620px at 8% -12%, rgba(94, 234, 212, 0.11), transparent 62%),
    radial-gradient(820px 520px at 92% -6%, rgba(167, 139, 250, 0.13), transparent 58%),
    var(--bg);
  -webkit-font-smoothing: antialiased;
}
.page { max-width: 960px; margin: 0 auto; }
.eyebrow {
  margin: 0 0 6px;
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--mute);
}
h1 { margin: 0 0 8px; font-size: 28px; font-weight: 600; letter-spacing: -0.01em; }
h2 { margin: 0 0 10px; font-size: 17px; font-weight: 600; }
h3 {
  margin: 22px 0 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--mute);
}
p { margin: 0 0 8px; }
.masthead { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-end; justify-content: space-between; padding-bottom: 22px; }
.meta { color: var(--dim); font-size: 12.5px; margin: 0; }
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 6px 0 26px; }
.kpi {
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid var(--line);
  background: var(--panel);
}
.kpi span { display: block; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--mute); }
.kpi b { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.block, .session {
  margin-bottom: 22px;
  padding: 20px 22px;
  border-radius: 18px;
  border: 1px solid var(--line);
  background: var(--panel);
}
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  text-align: left;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--mute);
  font-weight: 500;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
}
td { padding: 7px 8px; border-bottom: 1px solid rgba(148, 163, 184, 0.06); color: var(--dim); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.name { color: var(--text); }
.session-head { display: flex; gap: 18px; align-items: flex-start; justify-content: space-between; }
.session-title { min-width: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.chip {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  background: rgba(148, 163, 184, 0.06);
  font-size: 10.5px;
  color: var(--dim);
  white-space: nowrap;
}
.score {
  flex: 0 0 auto;
  width: 108px;
  height: 108px;
  border-radius: 50%;
  display: grid;
  place-content: center;
  text-align: center;
  background:
    radial-gradient(closest-side, #0a0f1a 85%, transparent 86%),
    conic-gradient(var(--tone) calc(var(--pct) * 1%), rgba(148, 163, 184, 0.16) 0);
}
.score b { font-size: 30px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.1; }
.score em { font-size: 10.5px; font-style: normal; color: var(--dim); }
.dims { display: flex; flex-direction: column; gap: 6px; margin-top: 16px; }
.dim {
  display: grid;
  grid-template-columns: 118px minmax(0, 1fr) 34px 40px;
  gap: 10px;
  align-items: center;
  font-size: 12px;
  color: var(--dim);
}
.dim-name { color: var(--text); }
.dim-bar { height: 5px; border-radius: 999px; background: rgba(148, 163, 184, 0.12); overflow: hidden; }
.dim-bar i { display: block; height: 100%; border-radius: 999px; }
.dim-score { text-align: right; font-variant-numeric: tabular-nums; color: var(--text); }
.dim-lost { text-align: right; font-variant-numeric: tabular-nums; font-size: 11px; color: var(--mute); }
.findings, .advice, .issues { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
.finding {
  padding: 10px 12px 10px 14px;
  border-left: 2px solid var(--mute);
  border-radius: 0 10px 10px 0;
  background: rgba(148, 163, 184, 0.04);
}
.finding.sev-error { border-left-color: #fb7185; background: rgba(251, 113, 133, 0.06); }
.finding.sev-warn { border-left-color: #fbbf24; background: rgba(251, 191, 36, 0.05); }
.finding.sev-info { border-left-color: #60a5fa; background: rgba(96, 165, 250, 0.05); }
.finding-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.sev { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--mute); }
.sev-error .sev { color: #fda4af; }
.sev-warn .sev { color: #fcd34d; }
.sev-info .sev { color: #93c5fd; }
.rule { font-weight: 600; font-size: 13.5px; }
.finding-body { margin: 4px 0 0; color: var(--dim); font-size: 12.5px; }
.evidence {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(6, 10, 18, 0.55);
  border: 1px solid var(--line);
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--dim);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.advice { counter-reset: advice; }
.advice li {
  position: relative;
  padding: 6px 0 6px 26px;
  color: var(--dim);
  font-size: 13px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.06);
}
.advice li::before {
  counter-increment: advice;
  content: counter(advice);
  position: absolute;
  left: 0;
  top: 6px;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  display: grid;
  place-content: center;
  font-size: 10px;
  color: #06231f;
  background: #5eead4;
}
.advice .chip { margin-left: 6px; }
.issues li { font-size: 12.5px; color: var(--dim); }
.issues code { font-family: var(--mono); font-size: 11.5px; color: #fcd34d; }
.empty { color: var(--mute); font-size: 13px; }
.note {
  margin: 12px 0 0;
  padding: 8px 12px;
  border-radius: 10px;
  background: rgba(251, 191, 36, 0.07);
  border: 1px solid rgba(251, 191, 36, 0.2);
  color: #fcd34d;
  font-size: 12px;
}
.masthead .score em { color: var(--mute); }
footer {
  margin-top: 30px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
  color: var(--mute);
  font-size: 11.5px;
  line-height: 1.7;
}
@media (max-width: 720px) {
  body { padding: 24px 14px 40px; }
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .session-head { flex-direction: column; }
  .dim { grid-template-columns: 92px minmax(0, 1fr) 30px 34px; }
}
@media print {
  :root { color-scheme: light; }
  body {
    background: #fff;
    color: #111827;
    padding: 0;
    font-size: 11.5pt;
  }
  .page { max-width: none; }
  .kpi, .session, .block { background: #fff; border-color: #d7dee9; break-inside: avoid; }
  /* 分数环的内遮罩是深色实心：不改就会在白纸上印出一块黑饼。 */
  .score {
    background:
      radial-gradient(closest-side, #fff 85%, transparent 86%),
      conic-gradient(var(--tone) calc(var(--pct) * 1%), #e5e7eb 0);
  }
  .score b, .score em { color: #111827; }
  td.name { color: #111827; }
  h1 { color: #111827; }
  h2, h3, .dim-name, .rule, .dim-score { color: #111827; }
  td, .finding-body, .advice li, .meta, .chip, .issues li, .empty { color: #374151; }
  .chip { border-color: #d7dee9; background: #f3f5f9; }
  .finding { background: #f8fafc; border-left-color: #94a3b8; }
  .finding.sev-error { background: #fff1f2; border-left-color: #e11d48; }
  .finding.sev-warn { background: #fffbeb; border-left-color: #d97706; }
  .finding.sev-info { background: #eff6ff; border-left-color: #2563eb; }
  .evidence { background: #f8fafc; border-color: #e2e8f0; color: #334155; }
  .sev, .sev-error .sev, .sev-warn .sev, .sev-info .sev, .eyebrow { color: #4b5563; }
  .advice li::before { background: #0f766e; color: #fff; }
  footer { border-color: #d7dee9; color: #4b5563; }
}
`

export function buildHtmlReport({ entries, pack, generatedAt, locale }: ReportInput): string {
  const t: Translate = (key, params) => translate(locale, key, params)

  const totalSteps = entries.reduce((sum, entry) => sum + entry.trajectory.steps.length, 0)
  const totalTokens = entries.reduce((sum, entry) => sum + entry.trajectory.meta.totalTokens, 0)
  const average =
    entries.length > 0
      ? Math.round(entries.reduce((sum, entry) => sum + entry.card.overall, 0) / entries.length)
      : 100
  const ruleCount = pack.rules.filter((rule) => rule.enabled !== false).length

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
