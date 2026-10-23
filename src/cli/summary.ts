/** 终端里的表格与结论（纯字符串，方便断言）。
 *
 *  中日韩字符占两列，用 `displayWidth` 算宽度，否则表格对不齐——这是命令行
 *  输出最容易露怯的地方，也最容易在测试里锁住。
 */

import { translate, type Locale, type MessageKey } from '../i18n/core'
import type { BatchResult } from './batch'

/** 全角/宽字符占 2 列。覆盖 CJK、假名、韩文与常用全角标点。 */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f)
    width += wide ? 2 : 1
  }
  return width
}

function pad(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const gap = Math.max(0, width - displayWidth(text))
  return align === 'left' ? text + ' '.repeat(gap) : ' '.repeat(gap) + text
}

export interface SummaryOptions {
  quiet?: boolean
}

export function renderSummary(result: BatchResult, locale: Locale, options: SummaryOptions = {}): string {
  const t = (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params)
  const lines: string[] = []

  const sessions = result.entries.length
  lines.push(
    t('cli.summary', {
      files: result.files.length,
      sessions,
      average: sessions > 0 ? result.average : '—',
      ms: result.elapsedMs,
    }),
  )

  if (!options.quiet) {
    const rows = result.files.map((file) => ({
      file: file.file,
      sessions: file.error ? '—' : String(file.sessions),
      score: file.error ? '—' : String(file.score),
      grade: file.error ? '—' : file.grade,
    }))
    const headers = {
      file: t('cli.headerFile'),
      sessions: t('cli.headerSessions'),
      score: t('cli.headerScore'),
      grade: t('cli.headerGrade'),
    }
    const fileWidth = Math.max(displayWidth(headers.file), ...rows.map((row) => displayWidth(row.file)))
    const sessionWidth = Math.max(
      displayWidth(headers.sessions),
      ...rows.map((row) => displayWidth(row.sessions)),
    )
    const scoreWidth = Math.max(displayWidth(headers.score), ...rows.map((row) => displayWidth(row.score)))
    const gradeWidth = Math.max(displayWidth(headers.grade), ...rows.map((row) => displayWidth(row.grade)))

    lines.push(
      [
        pad(headers.file, fileWidth),
        pad(headers.sessions, sessionWidth, 'right'),
        pad(headers.score, scoreWidth, 'right'),
        pad(headers.grade, gradeWidth, 'right'),
      ].join('  '),
    )
    for (const row of rows) {
      lines.push(
        [
          pad(row.file, fileWidth),
          pad(row.sessions, sessionWidth, 'right'),
          pad(row.score, scoreWidth, 'right'),
          pad(row.grade, gradeWidth, 'right'),
        ].join('  '),
      )
    }

    for (const file of result.files) {
      if (!file.error) continue
      lines.push(`  ✗ ${file.file} · ${t(`error.${file.error.code}` as MessageKey)}: ${file.error.message}`)
    }

    if (result.worst) {
      lines.push(
        t('cli.worst', { file: result.worst.file, score: result.worst.score, grade: result.worst.grade }),
      )
    }
  }

  if (result.semantic) {
    lines.push(
      t('cli.semantic', {
        sessions: result.semantic.sessions,
        findings: result.semantic.findings,
      }),
    )
    if (result.semantic.issues.length > 0) {
      lines.push(t('cli.semanticIssues', { count: result.semantic.issues.length }))
      for (const issue of result.semantic.issues.slice(0, 3)) {
        lines.push(`  ✗ ${issue.file} · ${issue.message}`)
      }
    }
  }

  if (result.failedFiles > 0) lines.push(t('cli.failedFiles', { count: result.failedFiles }))

  if (result.gate) {
    lines.push(
      result.gate.passed
        ? t('cli.gatePassed', { threshold: result.gate.threshold })
        : t('cli.gateFailed', { threshold: result.gate.threshold, count: result.gate.offenders.length }),
    )
    for (const offender of result.gate.offenders) {
      lines.push(t('cli.gateOffender', { file: offender.label, score: offender.score }))
    }
  }

  return lines.join('\n')
}

export interface HelpOptions {
  version: string
}

export function renderHelp(locale: Locale, { version }: HelpOptions): string {
  const t = (key: MessageKey) => translate(locale, key)
  const lines = [
    `${t('app.name')} v${version} — ${t('cli.tagline')}`,
    '',
    t('cli.usage'),
    '',
    `${t('cli.sectionOptions')}:`,
    `  ${t('cli.optFormat')}`,
    `  ${t('cli.optOut')}`,
    `  ${t('cli.optLocale')}`,
    `  ${t('cli.optPack')}`,
    `  ${t('cli.optFailBelow')}`,
    `  ${t('cli.optMaxFiles')}`,
    `  ${t('cli.optMaxBytes')}`,
    `  ${t('cli.optCompare')}`,
    `  ${t('cli.optPackCompare')}`,
    `  ${t('cli.optSemantic')}`,
    `  ${t('cli.optSemanticDryRun')}`,
    `  ${t('cli.optLlmUrl')}`,
    `  ${t('cli.optLlmModel')}`,
    `  ${t('cli.optSemanticLimit')}`,
    `  ${t('cli.optQuiet')}`,
    `  ${t('cli.optHelp')}`,
    '',
    `${t('cli.sectionExit')}:`,
    `  ${t('cli.exitOk')}`,
    `  ${t('cli.exitGate')}`,
    `  ${t('cli.exitError')}`,
    '',
    `${t('cli.sectionExamples')}:`,
    `  ${t('cli.example1')}`,
    `  ${t('cli.example2')}`,
  ]
  return lines.join('\n')
}
