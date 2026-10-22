/** Rule engine: dimensions + declarative rules + evaluation.
 *
 *  A rule is data. Its predicate is an expression over either the trajectory
 *  metrics (`scope: 'trajectory'`) or a single step context (`scope: 'step'`).
 *  That is what makes the rule set editable at runtime: the UI ships a JSON
 *  rule pack, and adding a dimension is just adding a dimension record plus
 *  rules that reference it.
 */

import { evaluatePredicate, ExprError } from './expr'
import { computeMetrics, type TrajectoryMetrics } from './metrics'
import type { Severity, Step, Trajectory } from './types'

export interface Dimension {
  id: string
  label: string
  weight: number
  color: string
  description: string
}

export interface Rule {
  id: string
  dimension: string
  severity: Severity
  title: string
  scoreImpact: number
  scope: 'step' | 'trajectory'
  expr: string
  message: string
  enabled: boolean
  builtin: boolean
}

export interface RulePack {
  version: number
  name: string
  dimensions: Dimension[]
  rules: Rule[]
}

export interface Finding {
  id: string
  ruleId: string
  ruleTitle: string
  dimension: string
  severity: Severity
  message: string
  stepIndex?: number
  evidence?: string
  impact: number
  manual?: boolean
}

export interface RuleIssue {
  ruleId: string
  message: string
}

export interface Annotation {
  id: string
  trajectoryId: string
  stepIndex?: number
  dimension: string
  severity: Severity
  note: string
}

export const SEVERITY_FACTOR: Record<Severity, number> = {
  error: 1,
  warn: 0.65,
  info: 0.3,
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  error: '严重',
  warn: '警告',
  info: '提示',
}

export const SEVERITY_ORDER: Record<Severity, number> = {
  error: 0,
  warn: 1,
  info: 2,
}

export const DIMENSIONS: Dimension[] = [
  {
    id: 'structure',
    label: '结构合法性',
    weight: 0.3,
    color: '#60a5fa',
    description: '角色交替、工具调用配对、参数与内容完整性',
  },
  {
    id: 'execution',
    label: '执行健康度',
    weight: 0.3,
    color: '#fb7185',
    description: '工具失败、重试风暴、死循环、任务是否收尾',
  },
  {
    id: 'efficiency',
    label: '效率与成本',
    weight: 0.2,
    color: '#fbbf24',
    description: '轮次、token、重复调用与上下文膨胀',
  },
  {
    id: 'semantic',
    label: '语义质量',
    weight: 0.2,
    color: '#a78bfa',
    description: '断言是否有依据、是否泄露敏感信息、人工标注',
  },
]

function rule(
  partial: Omit<Rule, 'enabled' | 'builtin'> & Partial<Pick<Rule, 'enabled' | 'builtin'>>,
): Rule {
  return { enabled: true, builtin: true, ...partial }
}

export const DEFAULT_RULES: Rule[] = [
  rule({
    id: 'structure-unpaired-call',
    dimension: 'structure',
    severity: 'error',
    title: '工具调用缺少结果',
    scoreImpact: 15,
    scope: 'step',
    expr: 'unpairedCalls > 0',
    message: '第 {step} 步有 {unpairedCalls} 个 tool_call 没有配对结果，轨迹疑似被截断',
  }),
  rule({
    id: 'structure-orphan-result',
    dimension: 'structure',
    severity: 'error',
    title: '工具结果无对应调用',
    scoreImpact: 10,
    scope: 'step',
    expr: 'role == "tool" and forCallId == ""',
    message: '第 {step} 步的工具结果找不到对应调用，链路已断',
  }),
  rule({
    id: 'structure-invalid-args',
    dimension: 'structure',
    severity: 'error',
    title: '工具参数非法 JSON',
    scoreImpact: 12,
    scope: 'step',
    expr: 'invalidArgs > 0',
    message: '第 {step} 步有 {invalidArgs} 个工具参数不是合法 JSON',
  }),
  rule({
    id: 'structure-empty-assistant',
    dimension: 'structure',
    severity: 'warn',
    title: '空助手回复',
    scoreImpact: 6,
    scope: 'step',
    expr: 'role == "assistant" and textLen == 0 and toolCallCount == 0',
    message: '第 {step} 步是空助手回复（既无文本也无工具调用）',
  }),
  rule({
    id: 'structure-double-user',
    dimension: 'structure',
    severity: 'warn',
    title: '连续 user 消息',
    scoreImpact: 4,
    scope: 'step',
    expr: 'role == "user" and prevRole == "user"',
    message: '第 {step} 步与前一条同为 user，中间缺少助手回应',
  }),
  rule({
    id: 'structure-no-system',
    dimension: 'structure',
    severity: 'info',
    title: '缺少系统提示词',
    scoreImpact: 2,
    scope: 'trajectory',
    expr: 'hasSystem == false',
    message: '整条轨迹没有 system / developer 提示词，行为约束不可追溯',
  }),
  rule({
    id: 'structure-empty-tool-result',
    dimension: 'structure',
    severity: 'info',
    title: '工具返回空内容',
    scoreImpact: 2,
    scope: 'step',
    expr: 'role == "tool" and resultChars == 0',
    message: '第 {step} 步工具返回空内容，无法判断调用是否生效',
  }),
  rule({
    id: 'structure-multimodal',
    dimension: 'structure',
    severity: 'info',
    title: '含未解析的多模态片段',
    scoreImpact: 2,
    scope: 'step',
    expr: 'hasImage == true',
    message: '第 {step} 步含图片片段，本轮质检未解析其内容',
  }),
  rule({
    id: 'structure-unknown-role',
    dimension: 'structure',
    severity: 'info',
    title: '无法识别的角色',
    scoreImpact: 2,
    scope: 'step',
    expr: 'role == "unknown"',
    message: '第 {step} 步的角色无法识别，可能来自未适配的日志格式',
  }),

  rule({
    id: 'exec-tool-error',
    dimension: 'execution',
    severity: 'warn',
    title: '工具返回错误',
    scoreImpact: 8,
    scope: 'step',
    expr: 'toolErrorCount > 0',
    message: '第 {step} 步有 {toolErrorCount} 个工具调用返回错误',
  }),
  rule({
    id: 'exec-error-rate',
    dimension: 'execution',
    severity: 'error',
    title: '工具失败率过高',
    scoreImpact: 16,
    scope: 'trajectory',
    expr: 'toolCalls > 0 and errorRate >= 0.3',
    message: '工具失败率 {errorRatePercent}%（{toolErrors}/{toolCalls}），执行链不可靠',
  }),
  rule({
    id: 'exec-unfinished',
    dimension: 'execution',
    severity: 'warn',
    title: '任务未收尾',
    scoreImpact: 10,
    scope: 'trajectory',
    expr: 'hasFinalAnswer == false',
    message: '轨迹结束时没有助手的最终答复，任务可能未完成',
  }),
  rule({
    id: 'exec-retry-storm',
    dimension: 'execution',
    severity: 'warn',
    title: '重复调用风暴',
    scoreImpact: 10,
    scope: 'trajectory',
    expr: 'maxRepeatRun >= 3',
    message: '存在连续 {maxRepeatRun} 次完全相同的工具调用，疑似重试风暴',
  }),
  rule({
    id: 'exec-dead-loop',
    dimension: 'execution',
    severity: 'error',
    title: '疑似死循环',
    scoreImpact: 25,
    scope: 'trajectory',
    expr: 'maxRepeatRun >= 8',
    message: '同一工具调用连续重复 {maxRepeatRun} 次，判定为死循环，轨迹基本不可用',
  }),
  rule({
    id: 'exec-slow-step',
    dimension: 'execution',
    severity: 'info',
    title: '单步耗时过长',
    scoreImpact: 3,
    scope: 'step',
    expr: 'durationMs >= 60000',
    message: '第 {step} 步耗时 {durationSeconds}s，明显偏慢',
  }),

  rule({
    id: 'eff-long-trace',
    dimension: 'efficiency',
    severity: 'warn',
    title: '轨迹过长',
    scoreImpact: 8,
    scope: 'trajectory',
    expr: 'stepCount > 40',
    message: '轨迹共 {stepCount} 步，超出常规长度，建议检查是否绕路',
  }),
  rule({
    id: 'eff-token-budget',
    dimension: 'efficiency',
    severity: 'warn',
    title: 'token 消耗偏高',
    scoreImpact: 8,
    scope: 'trajectory',
    expr: 'totalTokens > 60000',
    message: '全轨迹约 {totalTokens} tokens，成本偏高',
  }),
  rule({
    id: 'eff-duplicate-calls',
    dimension: 'efficiency',
    severity: 'warn',
    title: '重复工具调用',
    scoreImpact: 6,
    scope: 'trajectory',
    expr: 'duplicateCalls >= 2',
    message: '有 {duplicateCalls} 次参数完全相同的重复工具调用，存在冗余',
  }),
  rule({
    id: 'eff-context-bloat',
    dimension: 'efficiency',
    severity: 'info',
    title: '单条消息过大',
    scoreImpact: 3,
    scope: 'step',
    expr: 'textLen > 12000',
    message: '第 {step} 步单条消息 {textLen} 字符，上下文明显膨胀',
  }),
  rule({
    id: 'eff-no-tools',
    dimension: 'efficiency',
    severity: 'info',
    title: '全程未调用工具',
    scoreImpact: 2,
    scope: 'trajectory',
    expr: 'assistantTurns > 0 and toolCalls == 0',
    message: '全程未调用任何工具，若为任务型 Agent 需确认是否缺少工具能力',
  }),

  rule({
    id: 'sem-unverified-claim',
    dimension: 'semantic',
    severity: 'warn',
    title: '断言缺少依据',
    scoreImpact: 8,
    scope: 'step',
    expr: 'claimWithoutEvidence == true',
    message: '第 {step} 步引用了检索/文档结论，但此前没有任何工具调用，断言缺少依据',
  }),
  rule({
    id: 'sem-privacy-leak',
    dimension: 'semantic',
    severity: 'error',
    title: '疑似敏感信息泄露',
    scoreImpact: 15,
    scope: 'trajectory',
    expr: 'privacyHits > 0',
    message: '助手输出中发现 {privacyHits} 处手机号 / 邮箱 / 证件号 / 密钥形态的敏感信息',
  }),
]

export const DEFAULT_PACK: RulePack = {
  version: 1,
  name: '内置规则包 · v1',
  dimensions: DIMENSIONS,
  rules: DEFAULT_RULES,
}

const CLAIM_PATTERN =
  /(根据(搜索|查询|文档|资料|数据|报告)|搜索(结果|显示)|检索(结果|到)|数据显示|文档(中|里|指出|提到)|资料(显示|表明)|经查)/

const EVIDENCE_LIMIT = 180

function stepEvidence(step: Step): string {
  const text = step.text.trim()
  if (text) return text.length > EVIDENCE_LIMIT ? `${text.slice(0, EVIDENCE_LIMIT)}…` : text
  const calls = step.toolCalls.map((call) => `${call.name}(${call.rawArgs.slice(0, 60)})`)
  if (calls.length > 0) return calls.join(' · ')
  if (step.result) {
    const content = step.result.content.trim()
    return content.length > EVIDENCE_LIMIT ? `${content.slice(0, EVIDENCE_LIMIT)}…` : content || '（空结果）'
  }
  return '（空）'
}

interface StepContext {
  [key: string]: unknown
  index: number
  step: number
  role: string
  prevRole: string
  forCallId: string
  isLast: boolean
  textLen: number
  hasText: boolean
  toolCallCount: number
  unpairedCalls: number
  invalidArgs: number
  toolErrorCount: number
  resultChars: number
  resultIsError: boolean
  durationMs: number
  durationSeconds: number
  tokens: number
  chars: number
  claimWithoutEvidence: boolean
  hasImage: boolean
}

function buildStepContexts(trajectory: Trajectory): StepContext[] {
  const contexts: StepContext[] = []
  let priorCalls = 0

  trajectory.steps.forEach((step, i) => {
    const next = trajectory.steps[i + 1]
    const endTimestamp = step.result?.timestamp ?? next?.timestamp
    const durationMs =
      step.timestamp !== undefined && endTimestamp !== undefined
        ? Math.max(0, endTimestamp - step.timestamp)
        : 0

    contexts.push({
      index: step.index,
      step: step.index + 1,
      role: step.role,
      prevRole: trajectory.steps[i - 1]?.role ?? '',
      forCallId: step.forCallId ?? '',
      isLast: i === trajectory.steps.length - 1,
      textLen: step.text.length,
      hasText: step.text.trim().length > 0,
      toolCallCount: step.toolCalls.length,
      unpairedCalls: step.toolCalls.filter((call) => !call.result).length,
      invalidArgs: step.toolCalls.filter((call) => !call.argsValid).length,
      toolErrorCount: step.toolCalls.filter((call) => call.result?.isError).length,
      resultChars: (step.result?.content ?? '').trim().length,
      resultIsError: step.result?.isError ?? false,
      durationMs,
      durationSeconds: Math.round(durationMs / 1000),
      tokens: step.tokens.total,
      chars: step.charCount,
      claimWithoutEvidence:
        step.role === 'assistant' && CLAIM_PATTERN.test(step.text) && priorCalls === 0,
      hasImage: step.parseNotes.some((note) => note.includes('图片')),
    })

    priorCalls += step.toolCalls.length
  })

  return contexts
}

function renderMessage(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = context[key]
    return value === undefined ? match : String(value)
  })
}

export interface RunResult {
  findings: Finding[]
  metrics: TrajectoryMetrics
  ruleIssues: RuleIssue[]
}

export function runRules(trajectory: Trajectory, pack: RulePack = DEFAULT_PACK): RunResult {
  const metrics = computeMetrics(trajectory)
  const metricContext: Record<string, unknown> = { ...metrics }
  const stepContexts = buildStepContexts(trajectory)
  const findings: Finding[] = []
  const ruleIssues: RuleIssue[] = []

  for (const current of pack.rules) {
    if (current.enabled === false) continue
    if (!pack.dimensions.some((dimension) => dimension.id === current.dimension)) {
      ruleIssues.push({ ruleId: current.id, message: `维度 "${current.dimension}" 未定义，规则被跳过` })
      continue
    }

    const impact = current.scoreImpact * SEVERITY_FACTOR[current.severity]

    if (current.scope === 'trajectory') {
      try {
        if (!evaluatePredicate(current.expr, metricContext)) continue
        findings.push({
          id: `${trajectory.id}:${current.id}`,
          ruleId: current.id,
          ruleTitle: current.title,
          dimension: current.dimension,
          severity: current.severity,
          message: renderMessage(current.message, metricContext),
          impact,
        })
      } catch (error) {
        ruleIssues.push({
          ruleId: current.id,
          message: error instanceof ExprError ? error.message : String(error),
        })
      }
      continue
    }

    for (const context of stepContexts) {
      try {
        if (!evaluatePredicate(current.expr, context)) continue
        const step = trajectory.steps[context.index]
        findings.push({
          id: `${trajectory.id}:${current.id}:${context.index}`,
          ruleId: current.id,
          ruleTitle: current.title,
          dimension: current.dimension,
          severity: current.severity,
          message: renderMessage(current.message, context),
          stepIndex: context.index,
          evidence: step ? stepEvidence(step) : undefined,
          impact,
        })
      } catch (error) {
        ruleIssues.push({
          ruleId: current.id,
          message: error instanceof ExprError ? error.message : String(error),
        })
        break
      }
    }
  }

  return { findings, metrics, ruleIssues }
}

const MANUAL_IMPACT: Record<Severity, number> = { error: 8, warn: 5, info: 2 }

export function annotationFindings(
  trajectoryId: string,
  annotations: Annotation[],
): Finding[] {
  return annotations
    .filter((annotation) => annotation.trajectoryId === trajectoryId && annotation.note.trim() !== '')
    .map((annotation) => ({
      id: `manual:${annotation.id}`,
      ruleId: 'manual',
      ruleTitle: '人工标注',
      dimension: annotation.dimension,
      severity: annotation.severity,
      message: annotation.note.trim(),
      stepIndex: annotation.stepIndex,
      impact: MANUAL_IMPACT[annotation.severity],
      manual: true,
    }))
}

/** Validate a user-supplied rule pack. Returns human-readable problems. */
export function validatePack(pack: unknown): { ok: true; pack: RulePack } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (typeof pack !== 'object' || pack === null) return { ok: false, errors: ['规则包必须是 JSON 对象'] }
  const candidate = pack as Partial<RulePack>

  if (!Array.isArray(candidate.dimensions) || candidate.dimensions.length === 0) {
    errors.push('dimensions 必须是非空数组')
  }
  if (!Array.isArray(candidate.rules)) errors.push('rules 必须是数组')

  const dimensionIds = new Set<string>()
  for (const dimension of candidate.dimensions ?? []) {
    if (typeof dimension.id !== 'string' || !dimension.id) errors.push('维度缺少 id')
    else if (dimensionIds.has(dimension.id)) errors.push(`维度 id 重复：${dimension.id}`)
    else dimensionIds.add(dimension.id)
    if (typeof dimension.label !== 'string') errors.push(`维度 ${String(dimension.id)} 缺少 label`)
    if (typeof dimension.weight !== 'number' || dimension.weight < 0) {
      errors.push(`维度 ${String(dimension.id)} 的 weight 必须是非负数`)
    }
  }

  const ruleIds = new Set<string>()
  for (const current of candidate.rules ?? []) {
    if (typeof current.id !== 'string' || !current.id) errors.push('规则缺少 id')
    else if (ruleIds.has(current.id)) errors.push(`规则 id 重复：${current.id}`)
    else ruleIds.add(current.id)
    if (!dimensionIds.has(current.dimension)) {
      errors.push(`规则 ${String(current.id)} 指向未定义的维度 ${String(current.dimension)}`)
    }
    if (!['error', 'warn', 'info'].includes(current.severity)) {
      errors.push(`规则 ${String(current.id)} 的 severity 只能是 error / warn / info`)
    }
    if (current.scope !== 'step' && current.scope !== 'trajectory') {
      errors.push(`规则 ${String(current.id)} 的 scope 只能是 step / trajectory`)
    }
    if (typeof current.expr !== 'string' || !current.expr.trim()) {
      errors.push(`规则 ${String(current.id)} 缺少 expr`)
    }
    if (typeof current.scoreImpact !== 'number') errors.push(`规则 ${String(current.id)} 缺少 scoreImpact`)
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, pack: candidate as RulePack }
}
