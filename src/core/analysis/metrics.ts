/** Derived metrics: the numbers rules are allowed to talk about.
 *
 *  Computed once per trajectory so a predicate is a cheap tree walk, never a
 *  scan of the whole trace. Every metric name here is mirrored in the rule
 *  contract, and a test keeps the two lists in sync.
 */

import type { Trajectory } from '../model'

export interface TrajectoryMetrics {
  stepCount: number
  userTurns: number
  assistantTurns: number
  toolSteps: number
  toolCalls: number
  toolErrors: number
  unpairedCalls: number
  orphanResults: number
  invalidArgs: number
  emptyAssistant: number
  emptyResults: number
  imageSteps: number
  totalTokens: number
  maxStepTokens: number
  maxTextChars: number
  duplicateCalls: number
  maxRepeatRun: number
  errorRate: number
  errorRatePercent: number
  durationMs: number
  hasSystem: boolean
  hasFinalAnswer: boolean
  consecutiveUser: number
  privacyHits: number
  claimWithoutEvidence: number
  assistantWithoutTools: boolean
}

const PRIVACY_PATTERNS: RegExp[] = [
  /(?<!\d)1[3-9]\d{9}(?!\d)/g, // mainland mobile
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // email
  /(?<!\d)\d{17}[\dXx](?!\d)/g, // national id
  /\bsk-[A-Za-z0-9]{16,}\b/g, // provider api key
]

const CLAIM_PATTERN =
  /(根据(搜索|查询|文档|资料|数据|报告)|搜索(结果|显示)|检索(结果|到)|数据显示|文档(中|里|指出|提到)|资料(显示|表明)|经查)/

function countPrivacyHits(text: string): number {
  let hits = 0
  for (const pattern of PRIVACY_PATTERNS) {
    const matches = text.match(pattern)
    hits += matches ? matches.length : 0
  }
  return hits
}

function callSignature(name: string, rawArgs: string): string {
  let normalized = rawArgs.trim()
  try {
    normalized = JSON.stringify(JSON.parse(normalized))
  } catch {
    // keep the raw string; an invalid payload is still comparable to itself
  }
  return `${name}|${normalized}`
}

export function computeMetrics(trajectory: Trajectory): TrajectoryMetrics {
  const { steps } = trajectory

  let toolCalls = 0
  let toolErrors = 0
  let unpairedCalls = 0
  let orphanResults = 0
  let invalidArgs = 0
  let emptyResults = 0
  let imageSteps = 0
  let consecutiveUser = 0
  let claimWithoutEvidence = 0
  let priorCalls = 0
  let privacyHits = 0

  const signatures: string[] = []
  let maxRepeatRun = 0
  let currentRun = 0
  let previousSignature = ''

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]
    if (!step) continue

    if (step.role === 'user' && steps[i - 1]?.role === 'user') consecutiveUser += 1
    if (step.role === 'assistant') {
      privacyHits += countPrivacyHits(step.text)
      if (CLAIM_PATTERN.test(step.text) && priorCalls === 0) claimWithoutEvidence += 1
    }
    if (step.parseNotes.some((note) => note.includes('图片'))) imageSteps += 1

    for (const call of step.toolCalls) {
      toolCalls += 1
      if (!call.argsValid) invalidArgs += 1
      if (!call.result) unpairedCalls += 1
      if (call.result?.isError) toolErrors += 1

      const signature = callSignature(call.name, call.rawArgs)
      signatures.push(signature)
      currentRun = signature === previousSignature ? currentRun + 1 : 1
      maxRepeatRun = Math.max(maxRepeatRun, currentRun)
      previousSignature = signature
    }

    if (step.role === 'tool') {
      if (!step.forCallId) orphanResults += 1
      if ((step.result?.content ?? '').trim() === '') emptyResults += 1
    }

    priorCalls += step.toolCalls.length
  }

  const assistantTurns = steps.filter((step) => step.role === 'assistant').length
  const errorRate = toolCalls > 0 ? toolErrors / toolCalls : 0
  const lastStep = steps[steps.length - 1]
  const hasFinalAnswer =
    lastStep !== undefined && lastStep.role === 'assistant' && lastStep.text.trim().length > 0
  const timestamps = steps.map((step) => step.timestamp).filter((ts): ts is number => ts !== undefined)

  return {
    stepCount: steps.length,
    userTurns: steps.filter((step) => step.role === 'user').length,
    assistantTurns,
    toolSteps: steps.filter((step) => step.role === 'tool').length,
    toolCalls,
    toolErrors,
    unpairedCalls,
    orphanResults,
    invalidArgs,
    emptyAssistant: steps.filter(
      (step) => step.role === 'assistant' && step.text.trim() === '' && step.toolCalls.length === 0,
    ).length,
    emptyResults,
    imageSteps,
    totalTokens: trajectory.meta.totalTokens,
    maxStepTokens: steps.reduce((max, step) => Math.max(max, step.tokens.total), 0),
    maxTextChars: steps.reduce((max, step) => Math.max(max, step.text.length), 0),
    duplicateCalls: signatures.length - new Set(signatures).size,
    maxRepeatRun,
    errorRate,
    errorRatePercent: Math.round(errorRate * 100),
    durationMs:
      trajectory.meta.startedAt !== undefined && trajectory.meta.endedAt !== undefined
        ? Math.max(0, trajectory.meta.endedAt - trajectory.meta.startedAt)
        : timestamps.length > 1
          ? Math.max(...timestamps) - Math.min(...timestamps)
          : 0,
    hasSystem: steps.some((step) => step.role === 'system' || step.role === 'developer'),
    hasFinalAnswer,
    consecutiveUser,
    privacyHits,
    claimWithoutEvidence,
    assistantWithoutTools: assistantTurns > 0 && toolCalls === 0,
  }
}
