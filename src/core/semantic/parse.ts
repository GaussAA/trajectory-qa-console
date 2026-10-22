/** 解析模型输出：宽进严出。
 *
 *  宽进：模型可能套 Markdown 代码块、返回裸数组、字段多寡不一。
 *  严出：类别必须是枚举值，步号必须落在轨迹范围，条数与长度都要封顶——
 *  否则一条幻觉出来的「step 999」足以把报告搅乱。
 */

import { z } from 'zod'
import { fail, ok, type Result } from '../model'
import { SEMANTIC_CATEGORIES, type SemanticFinding } from './types'

const findingSchema = z.object({
  category: z.enum(SEMANTIC_CATEGORIES as [string, ...string[]]),
  step: z.number().int().min(1).optional(),
  severity: z.enum(['error', 'warn', 'info']).default('warn'),
  quote: z.string().max(600).optional(),
  reason: z.string().min(1).max(1200),
})

const payloadSchema = z.object({
  findings: z.array(findingSchema).max(50).default([]),
})

/** 去掉 ```json 围栏，并截取最外层大括号（模型常爱加客套话）。 */
export function extractJson(raw: string): string | null {
  let text = raw
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/```\s*$/, '')
  text = text.trim()

  if (text.startsWith('[')) return text

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return text.slice(start, end + 1)
}

export interface ParseOptions {
  /** 轨迹步数，用于校验 1 基步号。 */
  stepCount: number
  maxFindings?: number
}

export function parseJudgement(raw: string, options: ParseOptions): Result<SemanticFinding[]> {
  const json = extractJson(raw)
  if (!json) return fail('analysis-failed', '模型输出里找不到 JSON')

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    return fail('analysis-failed', '模型输出的 JSON 无法解析', {
      reason: error instanceof Error ? error.message : String(error),
    })
  }

  // 容错：有的模型直接返回数组
  const normalized = Array.isArray(parsed) ? { findings: parsed } : parsed
  const validated = payloadSchema.safeParse(normalized)
  if (!validated.success) {
    return fail('analysis-failed', '模型输出的结构不符合约定', {
      issues: validated.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    })
  }

  const limit = options.maxFindings ?? 12
  const findings: SemanticFinding[] = []

  for (const item of validated.data.findings) {
    if (findings.length >= limit) break
    const step = item.step
    // 步号越界的判定直接丢弃步号（保留结论），不编造位置。
    const validStep = step !== undefined && step >= 1 && step <= options.stepCount ? step : undefined
    findings.push({
      category: item.category as SemanticFinding['category'],
      step: validStep,
      severity: item.severity,
      quote: item.quote ? item.quote.slice(0, 200) : undefined,
      reason: item.reason.slice(0, 300),
    })
  }

  return ok(findings)
}
