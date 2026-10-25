/** 工具共用的零件：结果封装、参数读取、评分卡缓存、会话查找。 */

import { scoreSession, type ScoreCard, type SessionAnalysis } from '../../analysis'
import type { Severity } from '../../model'
import type { ToolContext, ToolOutcome } from '../types'

/** 单个工具结果的上限：一次返回几千行步详情会把上下文一次烧光，
 *  之后所有轮次都在读不完整的信息里瞎猜。 */
const MAX_RESULT_CHARS = 4000

/** 字段级截断：单个长文本字段用。整体结果超长走 `wrap` 的降级路径。 */
export function clip(text: string, limit: number): string {
  const flat = text.trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/** 超长时必须**仍是合法 JSON**。
 *
 *  早期版本直接 `slice` 字符串，结果吐给模型半截 JSON——它连"这是被截断的"
 *  都读不出来，只能瞎猜参数。现在退化成 `{truncated, note, preview}`：
 *  模型知道信息不全，也知道该缩小范围重试。 */
export function cap(value: unknown): string {
  const text = JSON.stringify(value)
  if (text.length <= MAX_RESULT_CHARS) return text
  return JSON.stringify({
    truncated: true,
    note: `结果超过 ${MAX_RESULT_CHARS} 字，已只保留开头；请缩小范围再问。`,
    preview: text.slice(0, MAX_RESULT_CHARS),
  })
}

export function wrap(value: unknown): ToolOutcome {
  return { ok: true, content: cap(value) }
}

export function reject(message: string, extra?: Record<string, unknown>): ToolOutcome {
  return { ok: false, content: cap({ error: message, ...extra }) }
}

export function readString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export function readInt(args: Record<string, unknown>, key: string): number | null {
  const value = args[key]
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value)
  return null
}

export function isSeverity(value: unknown): value is Severity {
  return value === 'error' || value === 'warn' || value === 'info'
}

/** 评分卡在一次诊断内复用：24 次工具调用不该把规则跑 24 遍。
 *  规则包在整轮里不变，所以按会话 id 缓存就够。 */
export function cardOf(context: ToolContext, session: SessionAnalysis): ScoreCard {
  const hit = context.cards?.get(session.id)
  if (hit) return hit
  const card = scoreSession(session, context.pack, context.annotations)
  context.cards?.set(session.id, card)
  return card
}

export function findSession(context: ToolContext, id: string | null): SessionAnalysis | null {
  if (!id) return null
  return context.sessions.find((session) => session.id === id) ?? null
}

/** 找不到会话时把可用的 id 报回去——模型下一步就能自己纠正，
 *  比让它反复猜「是不是拼错了」省一整轮。 */
export function unknownSession(context: ToolContext, id: string | null): ToolOutcome {
  return reject('没有这个会话 id', {
    given: id,
    available: context.sessions.slice(0, 20).map((session) => session.id),
  })
}

export function findingView(finding: {
  ruleId: string
  severity: Severity
  dimension: string
  message: string
  stepIndex?: number
  evidence?: string
  impact: number
}) {
  return {
    ruleId: finding.ruleId,
    severity: finding.severity,
    dimension: finding.dimension,
    // 对外一律 1 基：与界面、报告、语义提示词同一个口径。
    step: finding.stepIndex === undefined ? null : finding.stepIndex + 1,
    message: finding.message,
    evidence: finding.evidence ?? null,
    impact: finding.impact,
  }
}
