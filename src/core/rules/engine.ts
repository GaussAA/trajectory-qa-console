/** The rule engine: builds evaluation contexts, runs compiled predicates, and
 *  returns findings. It trusts its input — pack validation happens at the
 *  contract seam — but never lets one broken rule stop the others.
 */

import { compileExpression, ExprError, truthy, type ExprContext } from '../expr'
import {
  SEVERITY_FACTOR,
  type Finding,
  type RuleIssue,
  type RulePack,
  type Step,
  type Trajectory,
} from '../model'
import { CLAIM_PATTERN, computeMetrics, type TrajectoryMetrics } from '../analysis/metrics'
import { DEFAULT_PACK } from './builtin-pack'

export interface StepContext {
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

const EVIDENCE_LIMIT = 180

export function buildStepContexts(trajectory: Trajectory): StepContext[] {
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
      claimWithoutEvidence: step.role === 'assistant' && CLAIM_PATTERN.test(step.text) && priorCalls === 0,
      hasImage: step.parseNotes.some((note) => note.includes('图片')),
    })

    priorCalls += step.toolCalls.length
  })

  return contexts
}

export function buildMetricContext(metrics: TrajectoryMetrics): ExprContext {
  return { ...metrics }
}

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

function renderMessage(template: string, context: ExprContext): string {
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

export function runRules(
  trajectory: Trajectory,
  pack: RulePack = DEFAULT_PACK,
  precomputedMetrics?: TrajectoryMetrics,
): RunResult {
  const metrics = precomputedMetrics ?? computeMetrics(trajectory)
  const metricContext = buildMetricContext(metrics)
  const stepContexts = buildStepContexts(trajectory)
  const findings: Finding[] = []
  const ruleIssues: RuleIssue[] = []

  for (const rule of pack.rules) {
    if (rule.enabled === false) continue
    if (!pack.dimensions.some((dimension) => dimension.id === rule.dimension)) {
      ruleIssues.push({ ruleId: rule.id, message: `维度 "${rule.dimension}" 未定义，规则被跳过` })
      continue
    }

    let predicate: ReturnType<typeof compileExpression>
    try {
      predicate = compileExpression(rule.expr)
    } catch (error) {
      ruleIssues.push({
        ruleId: rule.id,
        message: error instanceof ExprError ? error.message : String(error),
      })
      continue
    }

    const impact = rule.scoreImpact * SEVERITY_FACTOR[rule.severity]

    if (rule.scope === 'trajectory') {
      try {
        if (!truthy(predicate.run(metricContext))) continue
        findings.push({
          id: `${trajectory.id}:${rule.id}`,
          ruleId: rule.id,
          ruleTitle: rule.title,
          dimension: rule.dimension,
          severity: rule.severity,
          message: renderMessage(rule.message, metricContext),
          impact,
        })
      } catch (error) {
        ruleIssues.push({
          ruleId: rule.id,
          message: error instanceof ExprError ? error.message : String(error),
        })
      }
      continue
    }

    let failed: string | undefined
    for (const context of stepContexts) {
      try {
        if (!truthy(predicate.run(context as unknown as ExprContext))) continue
        const step = trajectory.steps[context.index]
        findings.push({
          id: `${trajectory.id}:${rule.id}:${context.index}`,
          ruleId: rule.id,
          ruleTitle: rule.title,
          dimension: rule.dimension,
          severity: rule.severity,
          message: renderMessage(rule.message, context as unknown as ExprContext),
          stepIndex: context.index,
          evidence: step ? stepEvidence(step) : undefined,
          impact,
        })
      } catch (error) {
        failed = error instanceof ExprError ? error.message : String(error)
        break
      }
    }
    if (failed) ruleIssues.push({ ruleId: rule.id, message: failed })
  }

  return { findings, metrics, ruleIssues }
}
