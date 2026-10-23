/** Report + diagnostics composition and file downloads.
 *
 *  Kept out of the UI so both "export" buttons and any future CLI share one
 *  definition of what a report contains.
 */

import { scoreSession, type ScoreCard } from '../core/analysis'
import type { RulePack } from '../core/model'
import type { Locale } from '../i18n/core'
import { buildJsonReport, buildMarkdownReport } from '../lib/report'
import { buildHtmlReport } from '../lib/report-html'
import type { WorkspaceState } from './workspace'
import type { Telemetry, TelemetryEvent } from './telemetry'

export interface ReportBundle {
  markdown: string
  json: string
  /** 单文件 HTML：给人看、给不懂命令行的同事看。 */
  html: string
}

export interface ReportOptions {
  generatedAt?: Date
  /** 报告语言跟界面走：同一份会话，中文导出给人看，英文导出给外部协作方。 */
  locale?: Locale
}

export function buildReportBundle(
  state: WorkspaceState,
  cards: Map<string, ScoreCard>,
  { generatedAt = new Date(), locale = 'zh-CN' }: ReportOptions = {},
): ReportBundle {
  const entries = state.sessions.flatMap((session) => {
    const card = cards.get(session.id)
    if (!card) return []
    // 报告里用用户起的名字；没起名就保持文件名。
    const custom = state.notes.find((note) => note.trajectoryId === session.trajectory.id)?.name
    const trajectory =
      custom && custom.trim() !== '' ? { ...session.trajectory, label: custom } : session.trajectory
    return [{ trajectory, card }]
  })
  const input = { entries, pack: state.pack, generatedAt, locale }
  return {
    markdown: buildMarkdownReport(input),
    json: buildJsonReport(input),
    html: buildHtmlReport(input),
  }
}

export function buildDiagnostics(
  state: WorkspaceState,
  cards: Map<string, ScoreCard>,
  events: TelemetryEvent[],
  generatedAt = new Date(),
): string {
  return JSON.stringify(
    {
      generatedAt: generatedAt.toISOString(),
      rulePack: { name: state.pack.name, version: state.pack.version, rules: state.pack.rules.length },
      sessions: state.sessions.map((session) => {
        const card = cards.get(session.id) ?? scoreSession(session, state.pack.dimensions)
        return {
          id: session.id,
          label: session.trajectory.label,
          source: session.trajectory.source,
          steps: session.trajectory.steps.length,
          tokens: session.trajectory.meta.totalTokens,
          score: card.overall,
          grade: card.grade,
          diagnostics: session.diagnostics,
          parseNotes: session.trajectory.parseNotes,
          ruleIssues: session.ruleIssues,
        }
      }),
      issues: state.issues,
      lastError: state.lastError,
      events,
    },
    null,
    2,
  )
}

export function downloadText(name: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function describeTelemetry(telemetry: Telemetry): TelemetryEvent[] {
  return telemetry.snapshot()
}

export type { RulePack }
