/** 批量分析：文件清单 → 逐文件结果 + 两份报告 + 门禁判定。
 *
 *  这一层刻意不打印任何东西、不读命令行、不碰退出码——它只做「算」。
 *  打印在 `summary.ts`，IO 与退出码在 `main.ts`，于是批量逻辑可以拿临时目录
 *  直接测，不必伪造 stdout。
 */

import { readFileSync, statSync } from 'node:fs'
import { basename, relative, sep } from 'node:path'
import { analyze, gradeOf, scoreSession, type ScoreCard, type SessionAnalysis } from '../core/analysis'
import type { AppError, Finding, RulePack } from '../core/model'
import { translate, type Locale } from '../i18n/core'
import { buildJsonReport, buildMarkdownReport, type ReportEntry } from '../lib/report'
import { buildHtmlReport } from '../lib/report-html'

export interface FileOutcome {
  /** 大写后的展示路径，报告与表格共用。 */
  file: string
  sessions: number
  /** 该文件内会话的平均分；分析失败时为 0。 */
  score: number
  grade: string
  error?: AppError
}

export interface GateOffender {
  file: string
  label: string
  score: number
}

export interface GateResult {
  threshold: number
  passed: boolean
  offenders: GateOffender[]
}

/** 语义复核钩子：给一条会话，返回可直接进评分卡的 findings。
 *  返回 `null` 表示「按预算跳过」，不计入已复核数；抛错表示失败，批量流程照旧。 */
export type SemanticHook = (session: SessionAnalysis) => Promise<Finding[] | null>

export interface SemanticIssue {
  file: string
  message: string
}

export interface BatchOptions {
  locale: Locale
  pack: RulePack
  failBelow: number | null
  maxFileBytes: number
  generatedAt?: Date
  semantic?: SemanticHook
}

export interface BatchResult {
  files: FileOutcome[]
  entries: ReportEntry[]
  markdown: string
  json: string
  html: string
  average: number
  worst: { file: string; label: string; score: number; grade: string } | null
  gate: GateResult | null
  failedFiles: number
  /** 语义复核成功的会话数与新增 finding 数。 */
  semantic: { sessions: number; findings: number; issues: SemanticIssue[] } | null
  elapsedMs: number
}

/** 报告里用相对路径（短、可读、可 diff）；跨盘或上级目录时回退文件名。 */
export function displayPath(file: string, cwd = process.cwd()): string {
  const rel = relative(cwd, file)
  const shown = !rel || rel.startsWith('..') ? basename(file) : rel
  // 统一用 /，否则 Windows 与 POSIX 产出的报告无法逐字节比对。
  return shown.split(sep).join('/')
}

function readTrace(
  file: string,
  maxFileBytes: number,
  locale: Locale,
): { ok: true; text: string } | { ok: false; error: AppError } {
  // 文案走字典，数值进 detail：界面与命令行在同一语言下说同一句话。
  const readFailed: AppError = {
    code: 'read-failed',
    message: translate(locale, 'error.read-failed'),
    detail: { file },
  }
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return { ok: false, error: readFailed }
  }
  if (size > maxFileBytes) {
    return {
      ok: false,
      error: {
        code: 'too-large',
        message: translate(locale, 'error.too-large'),
        detail: { size, limit: maxFileBytes },
      },
    }
  }
  try {
    return { ok: true, text: readFileSync(file, 'utf8') }
  } catch {
    return { ok: false, error: readFailed }
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

export async function runBatch(files: string[], options: BatchOptions): Promise<BatchResult> {
  const started = Date.now()
  const outcomes: FileOutcome[] = []
  const entries: ReportEntry[] = []
  const semantic = options.semantic ? { sessions: 0, findings: 0, issues: [] as SemanticIssue[] } : null

  for (const [index, file] of files.entries()) {
    const label = displayPath(file)
    const read = readTrace(file, options.maxFileBytes, options.locale)
    if (!read.ok) {
      outcomes.push({ file: label, sessions: 0, score: 0, grade: '—', error: read.error })
      continue
    }

    const analyzed = analyze({ source: read.text, label, idPrefix: `file${index}` })
    if (!analyzed.ok) {
      outcomes.push({ file: label, sessions: 0, score: 0, grade: '—', error: analyzed.error })
      continue
    }

    const cards: ScoreCard[] = []
    for (const session of analyzed.value) {
      const extra: Finding[] = []
      if (options.semantic && semantic) {
        try {
          const judged = await options.semantic(session)
          if (judged !== null) {
            extra.push(...judged)
            semantic.sessions += 1
            semantic.findings += judged.length
          }
        } catch (error) {
          // 语义失败不拖累整批：记一条 issue，规则结论照旧出。
          semantic.issues.push({
            file: label,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
      const card: ScoreCard = scoreSession(session, options.pack, [], extra)
      cards.push(card)
      entries.push({ trajectory: session.trajectory, card })
    }

    const score = mean(cards.map((card) => card.overall))
    outcomes.push({
      file: label,
      sessions: cards.length,
      score,
      grade: cards.length > 0 ? gradeOf(score).grade : '—',
    })
  }

  const allScores = entries.map((entry) => entry.card.overall)
  const average = mean(allScores)

  let worst: BatchResult['worst'] = null
  for (const entry of entries) {
    if (!worst || entry.card.overall < worst.score) {
      worst = {
        // `trajectory.source` 已是展示路径（解析时由 label 写入），不要再相对化一次。
        file: entry.trajectory.source,
        label: entry.trajectory.label,
        score: entry.card.overall,
        grade: entry.card.grade,
      }
    }
  }

  const threshold = options.failBelow
  let gate: GateResult | null = null
  if (threshold !== null) {
    const offenders = entries
      .filter((entry) => entry.card.overall < threshold)
      .map((entry) => ({
        file: entry.trajectory.source,
        label: entry.trajectory.label,
        score: entry.card.overall,
      }))
    gate = { threshold, passed: offenders.length === 0, offenders }
  }

  const report = {
    entries,
    pack: options.pack,
    generatedAt: options.generatedAt ?? new Date(),
    locale: options.locale,
  }

  return {
    files: outcomes,
    entries,
    markdown: buildMarkdownReport(report),
    json: buildJsonReport(report),
    html: buildHtmlReport(report),
    average,
    worst,
    gate,
    failedFiles: outcomes.filter((outcome) => outcome.error).length,
    semantic,
    elapsedMs: Date.now() - started,
  }
}
