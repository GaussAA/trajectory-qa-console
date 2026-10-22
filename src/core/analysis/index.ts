/** `analyze` — the single seam between "some text" and everything the UI needs.
 *
 *  It hides the pipeline order, the error semantics, the timing, and the
 *  per-session fan-out. Callers never touch parse/metrics/rules/score directly,
 *  so the implementation can be replaced (sync → worker) without touching UI.
 */

import {
  fail,
  ok,
  type Annotation,
  type Dimension,
  type Finding,
  type Result,
  type RuleIssue,
  type RulePack,
  type Trajectory,
} from '../model'
import { parseTrajectory } from '../parsing'
import { DEFAULT_PACK } from '../rules/builtin-pack'
import { runRules } from '../rules/engine'
import { computeMetrics, type TrajectoryMetrics } from './metrics'
import { annotationFindings, scoreTrajectory, type ScoreCard } from './score'

export { computeMetrics, type TrajectoryMetrics } from './metrics'
export {
  annotationFindings,
  capForErrors,
  gradeOf,
  scoreTrajectory,
  sortFindings,
  type DimensionScore,
  type ScoreCard,
} from './score'

export type Clock = () => number

const defaultClock: Clock =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now()

export interface AnalysisDiagnostics {
  /** Milliseconds spent in parsing. */
  parseMs: number
  /** Milliseconds spent computing metrics + rules for this session. */
  rulesMs: number
  /** Milliseconds for this session end-to-end. */
  totalMs: number
  sourceChars: number
  stepCount: number
}

export interface SessionAnalysis {
  /** Unique inside a workspace (batch prefix + session ordinal). */
  id: string
  trajectory: Trajectory
  metrics: TrajectoryMetrics
  /** Rule findings only; annotations are merged when a card is requested. */
  findings: Finding[]
  ruleIssues: RuleIssue[]
  diagnostics: AnalysisDiagnostics
}

export interface AnalyzeOptions {
  source: string
  label: string
  pack?: RulePack
  /** Prefix that keeps ids unique across ingestion batches. */
  idPrefix?: string
  maxSteps?: number
  clock?: Clock
}

let runSequence = 0

export function analyze(options: AnalyzeOptions): Result<SessionAnalysis[]> {
  const clock = options.clock ?? defaultClock
  const started = clock()

  const parsed = parseTrajectory(options.source, options.label, { maxSteps: options.maxSteps })
  if (!parsed.ok) return parsed

  const parseMs = clock() - started
  const pack = options.pack ?? DEFAULT_PACK
  const prefix = options.idPrefix ?? `run${(runSequence += 1)}`
  const analyses: SessionAnalysis[] = []

  try {
    for (let index = 0; index < parsed.value.length; index += 1) {
      const trajectory = parsed.value[index] as Trajectory
      const sessionStart = clock()
      const metrics = computeMetrics(trajectory)
      const { findings, ruleIssues } = runRules(trajectory, pack, metrics)
      const sessionEnd = clock()

      analyses.push({
        id: `${prefix}-${index}-${trajectory.id}`,
        trajectory,
        metrics,
        findings,
        ruleIssues,
        diagnostics: {
          parseMs,
          rulesMs: sessionEnd - sessionStart,
          totalMs: sessionEnd - started,
          sourceChars: options.source.length,
          stepCount: trajectory.steps.length,
        },
      })
    }
  } catch (error) {
    return fail('analysis-failed', '分析过程出错', {
      reason: error instanceof Error ? error.message : String(error),
      label: options.label,
    })
  }

  return ok(analyses)
}

/** Score a session with the current pack + optional manual annotations. */
export function scoreSession(
  analysis: SessionAnalysis,
  dimensions: Dimension[],
  annotations: Annotation[] = [],
): ScoreCard {
  const manual = annotationFindings(analysis.trajectory.id, annotations)
  return scoreTrajectory([...analysis.findings, ...manual], dimensions, analysis.ruleIssues)
}

export type { Finding, RuleIssue }
