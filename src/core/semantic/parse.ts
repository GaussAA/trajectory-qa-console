/** 解析模型输出：宽进严出。
 *
 *  宽进：模型可能套 Markdown 代码块、返回裸数组、字段多寡不一。
 *  严出：类别必须是枚举值，步号必须落在轨迹范围，条数与长度都要封顶——
 *  否则一条幻觉出来的「step 999」足以把报告搅乱。
 */

import * as z from 'zod/mini'
import { fail, ok, type Result } from '../model'
import { SEMANTIC_CATEGORIES, type SemanticFinding } from './types'

const findingSchema = z.object({
  category: z.enum(SEMANTIC_CATEGORIES as [string, ...string[]]),
  step: z.optional(z.int().check(z.minimum(1))),
  severity: z._default(z.enum(['error', 'warn', 'info']), 'warn'),
  quote: z.optional(z.string().check(z.maxLength(600))),
  reason: z.string().check(z.minLength(1), z.maxLength(1200)),
})

const payloadSchema = z.object({
  findings: z._default(z.array(findingSchema).check(z.maxLength(50)), []),
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
  /** 发给模型的那份摘要（已脱敏）。给了就核对每条引文是否真在里面；不给就不核对。 */
  digestText?: string
}

/** 空白折成一个空格，供引文比对用。摘要里的文本经过 `clip`（空白已压平），模型引用时
 *  可能带着换行或多余空格。 */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 引文是否真的出现在摘要里。
 *  模型常用 `…` 省略中间或结尾，所以按省略号切开，每一段都要在摘要里找得到。
 *  空白不敏感，大小写敏感：引文要求是原文的连续片段，不是大意。 */
export function quoteInDigest(quote: string, digest: string): boolean {
  const haystack = squash(digest)
  const segments = quote
    .split(/…|\.{3}/)
    .map(squash)
    .filter((segment) => segment.length > 0)
  return segments.length > 0 && segments.every((segment) => haystack.includes(segment))
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
    // 这条判定会并进评分、触发门禁。提示词要求引文是轨迹原文的连续片段，对不上的就是编造
    // （或者被轨迹里的注入文本带偏了）：降级并标记，而不是照常计分。没引文的判定不在此列。
    const unverified =
      options.digestText !== undefined && !!item.quote && !quoteInDigest(item.quote, options.digestText)
    findings.push({
      category: item.category as SemanticFinding['category'],
      step: validStep,
      severity: unverified ? 'info' : item.severity,
      quote: unverified ? undefined : item.quote ? item.quote.slice(0, 200) : undefined,
      reason: item.reason.slice(0, 300),
      ...(unverified ? { unverified: true } : {}),
    })
  }

  return ok(findings)
}
