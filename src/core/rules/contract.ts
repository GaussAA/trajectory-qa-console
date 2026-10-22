/** The rule contract: what a rule pack may contain, and which fields/expressions
 *  a rule may reference — validated once at the seam, so the engine can trust
 *  its input and the editor can explain mistakes precisely.
 */

import { z } from 'zod'
import { compileExpression, ExprError } from '../expr'
import type { RulePack } from '../model'
import type { TrajectoryMetrics } from '../analysis/metrics'
import type { StepContext } from './engine'

export type FieldType = 'number' | 'string' | 'boolean'

export interface FieldSpec {
  name: string
  type: FieldType
  description: string
}

export const PACK_LIMITS = {
  maxRules: 200,
  maxDimensions: 12,
  maxExpressionLength: 1000,
} as const

/** Compile-time guard: this record must cover every field of the step context. */
const STEP_FIELD_TYPES: Record<keyof StepContext, FieldType> = {
  index: 'number',
  step: 'number',
  role: 'string',
  prevRole: 'string',
  forCallId: 'string',
  isLast: 'boolean',
  textLen: 'number',
  hasText: 'boolean',
  toolCallCount: 'number',
  unpairedCalls: 'number',
  invalidArgs: 'number',
  toolErrorCount: 'number',
  resultChars: 'number',
  resultIsError: 'boolean',
  durationMs: 'number',
  durationSeconds: 'number',
  tokens: 'number',
  chars: 'number',
  claimWithoutEvidence: 'boolean',
  hasImage: 'boolean',
}

/** Compile-time guard: this record must cover every metric. */
const TRAJECTORY_FIELD_TYPES: Record<keyof TrajectoryMetrics, FieldType> = {
  stepCount: 'number',
  userTurns: 'number',
  assistantTurns: 'number',
  toolSteps: 'number',
  toolCalls: 'number',
  toolErrors: 'number',
  unpairedCalls: 'number',
  orphanResults: 'number',
  invalidArgs: 'number',
  emptyAssistant: 'number',
  emptyResults: 'number',
  imageSteps: 'number',
  totalTokens: 'number',
  maxStepTokens: 'number',
  maxTextChars: 'number',
  duplicateCalls: 'number',
  maxRepeatRun: 'number',
  errorRate: 'number',
  errorRatePercent: 'number',
  durationMs: 'number',
  hasSystem: 'boolean',
  hasFinalAnswer: 'boolean',
  consecutiveUser: 'number',
  privacyHits: 'number',
  claimWithoutEvidence: 'number',
  assistantWithoutTools: 'boolean',
}

const STEP_DESCRIPTIONS: Record<string, string> = {
  index: '步骤下标，从 0 开始',
  step: '步骤序号，从 1 开始',
  role: '角色：system / user / assistant / tool / unknown',
  prevRole: '上一步的角色，首步为空串',
  forCallId: '工具步配到的调用 id，未配对为空串',
  isLast: '是否为最后一步',
  textLen: '文本字符数',
  hasText: '是否有非空文本',
  toolCallCount: '本步工具调用数',
  unpairedCalls: '本步未配对的调用数',
  invalidArgs: '本步参数非法 JSON 的调用数',
  toolErrorCount: '本步返回错误的调用数',
  resultChars: '工具结果字符数',
  resultIsError: '工具结果是否错误',
  durationMs: '本步耗时（毫秒）',
  durationSeconds: '本步耗时（秒，取整）',
  tokens: '本步 token 估算',
  chars: '本步总字符数（含参数与结果）',
  claimWithoutEvidence: '助手引用了检索结论但此前无任何调用',
  hasImage: '本步含图片片段',
}

const TRAJECTORY_DESCRIPTIONS: Record<string, string> = {
  stepCount: '总步数',
  userTurns: 'user 消息数',
  assistantTurns: 'assistant 消息数',
  toolSteps: 'tool 消息数',
  toolCalls: '工具调用总数',
  toolErrors: '返回错误的调用数',
  unpairedCalls: '未配对的调用数',
  orphanResults: '无对应调用的工具结果数',
  invalidArgs: '参数非法 JSON 的调用数',
  emptyAssistant: '空助手回复数',
  emptyResults: '空工具结果数',
  imageSteps: '含图片片段的步数',
  totalTokens: '总 token（上报或估算）',
  maxStepTokens: '单步最大 token',
  maxTextChars: '单条消息最大字符数',
  duplicateCalls: '参数完全相同的重复调用数',
  maxRepeatRun: '同一调用最长连续重复次数',
  errorRate: '工具失败率（0–1）',
  errorRatePercent: '工具失败率（0–100 取整）',
  durationMs: '轨迹总时长（毫秒）',
  hasSystem: '是否含 system / developer 提示词',
  hasFinalAnswer: '是否以助手最终答复收尾',
  consecutiveUser: '连续 user 消息出现次数',
  privacyHits: '助手输出中的敏感信息命中数',
  claimWithoutEvidence: '无依据断言次数',
  assistantWithoutTools: '有助手回复但全程未调用工具',
}

export const STEP_FIELDS: FieldSpec[] = (
  Object.keys(STEP_FIELD_TYPES) as (keyof StepContext)[]
).map((name) => ({
  name,
  type: STEP_FIELD_TYPES[name],
  description: STEP_DESCRIPTIONS[name] ?? '',
}))

export const TRAJECTORY_FIELDS: FieldSpec[] = (
  Object.keys(TRAJECTORY_FIELD_TYPES) as (keyof TrajectoryMetrics)[]
).map((name) => ({
  name,
  type: TRAJECTORY_FIELD_TYPES[name],
  description: TRAJECTORY_DESCRIPTIONS[name] ?? '',
}))

export function fieldsForScope(scope: 'step' | 'trajectory'): FieldSpec[] {
  return scope === 'step' ? STEP_FIELDS : TRAJECTORY_FIELDS
}

// ---------- schema ----------

const dimensionSchema = z.object({
  id: z.string().min(1, '维度 id 不能为空'),
  label: z.string().min(1, '维度名不能为空'),
  weight: z.number().min(0, 'weight 不能为负').max(1, 'weight 不能大于 1'),
  color: z.string().min(1, '缺少颜色'),
  description: z.string().default(''),
})

const ruleSchema = z.object({
  id: z.string().min(1, '规则 id 不能为空'),
  dimension: z.string().min(1, '规则必须归属一个维度'),
  severity: z.enum(['error', 'warn', 'info'], { message: 'severity 只能是 error / warn / info' }),
  title: z.string().min(1, '缺少标题'),
  scoreImpact: z.number().min(0, '扣分不能为负').max(100, '单条扣分不应超过 100'),
  scope: z.enum(['step', 'trajectory'], { message: 'scope 只能是 step / trajectory' }),
  expr: z
    .string()
    .min(1, '缺少表达式')
    .max(PACK_LIMITS.maxExpressionLength, `表达式不得超过 ${PACK_LIMITS.maxExpressionLength} 字符`),
  message: z.string().min(1, '缺少提示文案').max(500, '提示文案过长'),
  enabled: z.boolean().default(true),
  builtin: z.boolean().default(false),
})

export const rulePackSchema = z.object({
  version: z.number().int('version 必须是整数').positive('version 必须为正'),
  name: z.string().min(1, '规则包需要名称'),
  dimensions: z.array(dimensionSchema).min(1, '至少需要一个维度').max(PACK_LIMITS.maxDimensions),
  rules: z.array(ruleSchema).max(PACK_LIMITS.maxRules),
})

export interface PackError {
  path: string
  message: string
}

export type PackValidation =
  | { ok: true; pack: RulePack }
  | { ok: false; errors: PackError[] }

function editDistance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  let previous = Array.from({ length: cols }, (_, i) => i)
  for (let i = 1; i < rows; i += 1) {
    const current = [i]
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      )
    }
    previous = current
  }
  return previous[cols - 1] as number
}

function nearest(name: string, candidates: string[]): string | undefined {
  let best: { name: string; score: number } | undefined
  for (const candidate of candidates) {
    const score = editDistance(name.toLowerCase(), candidate.toLowerCase())
    if (score <= 2 && (!best || score < best.score)) best = { name: candidate, score }
  }
  return best?.name
}

export function validatePack(input: unknown): PackValidation {
  const parsed = rulePackSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    }
  }

  const pack = parsed.data as RulePack
  const errors: PackError[] = []
  const dimensionIds = new Set<string>()

  pack.dimensions.forEach((dimension, index) => {
    if (dimensionIds.has(dimension.id)) {
      errors.push({ path: `dimensions.${index}.id`, message: `维度 id 重复：${dimension.id}` })
    }
    dimensionIds.add(dimension.id)
  })

  if (pack.dimensions.every((dimension) => dimension.weight === 0)) {
    errors.push({ path: 'dimensions', message: '至少一个维度的 weight 需要大于 0' })
  }

  const ruleIds = new Set<string>()
  pack.rules.forEach((rule, index) => {
    const path = `rules.${index}`
    if (ruleIds.has(rule.id)) {
      errors.push({ path: `${path}.id`, message: `规则 id 重复：${rule.id}` })
    }
    ruleIds.add(rule.id)

    if (!dimensionIds.has(rule.dimension)) {
      errors.push({
        path: `${path}.dimension`,
        message: `规则指向未定义的维度 "${rule.dimension}"`,
      })
    }

    let identifiers: readonly string[]
    try {
      identifiers = compileExpression(rule.expr).identifiers
    } catch (error) {
      errors.push({
        path: `${path}.expr`,
        message: error instanceof ExprError ? error.message : String(error),
      })
      return
    }

    const allowed = fieldsForScope(rule.scope).map((field) => field.name)
    for (const name of identifiers) {
      if (allowed.includes(name)) continue
      const hint = nearest(name, allowed)
      errors.push({
        path: `${path}.expr`,
        message: hint
          ? `未知字段 "${name}"，是否指 "${hint}"？`
          : `未知字段 "${name}"，${rule.scope} 作用域可用字段见规则包说明`,
      })
    }
  })

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, pack }
}

export function formatPackErrors(errors: PackError[]): string[] {
  return errors.map((error) => `${error.path}：${error.message}`)
}
