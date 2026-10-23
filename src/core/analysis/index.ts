/** `analyze` — the single seam between "some text" and everything the UI needs.
 *
 *  It hides the pipeline order, the error semantics, the timing, and the
 *  per-session fan-out. Callers never touch parse/metrics/rules/score directly,
 *  so the implementation can be replaced (sync → worker) without touching UI.
 *
 *  What `analyze` deliberately does NOT produce: rule findings or a score.
 *  Both depend on the rule pack, and the pack can change long after import —
 *  so they are derived on demand by `buildCard` / `scoreSession` instead of
 *  being frozen into the session. That is invariant 3 of CONTEXT.md ("a score
 *  card is always derived, never stored"), made true by construction rather
 *  than by remembering to recompute.
 */

import {
  fail,
  ok,
  type Annotation,
  type Finding,
  type Result,
  type RuleIssue,
  type RulePack,
  type Trajectory,
} from '../model'
import { parseTrajectory } from '../parsing'
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
  /** Milliseconds spent computing metrics for this session.
   *
   *  Rule evaluation is deliberately not timed here: it no longer happens at
   *  import time, but on every scoring request (see `buildCard`). */
  metricsMs: number
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
  diagnostics: AnalysisDiagnostics
}

/** A session that could not be analysed. Reported, never swallowed. */
export interface SessionIssue {
  /** Ordinal of the session inside its file. */
  index: number
  label: string
  message: string
}

export interface AnalyzeOutcome {
  sessions: SessionAnalysis[]
  /** Sessions dropped because they threw. One bad session costs only itself —
   *  invariant 5 — but the caller still hears about it. */
  issues: SessionIssue[]
}

export interface AnalyzeOptions {
  source: string
  label: string
  /** Prefix that keeps ids unique across ingestion batches. */
  idPrefix?: string
  maxSteps?: number
  clock?: Clock
}

let runSequence = 0

export function analyze(options: AnalyzeOptions): Result<AnalyzeOutcome> {
  const clock = options.clock ?? defaultClock
  const started = clock()

  const parsed = parseTrajectory(options.source, options.label, { maxSteps: options.maxSteps })
  if (!parsed.ok) return parsed

  const parseMs = clock() - started
  const prefix = options.idPrefix ?? `run${(runSequence += 1)}`
  const sessions: SessionAnalysis[] = []
  const issues: SessionIssue[] = []

  for (let index = 0; index < parsed.value.length; index += 1) {
    const trajectory = parsed.value[index] as Trajectory
    const sessionStart = clock()
    try {
      const metrics = computeMetrics(trajectory)
      const sessionEnd = clock()

      sessions.push({
        id: `${prefix}-${index}-${trajectory.id}`,
        trajectory,
        metrics,
        diagnostics: {
          parseMs,
          metricsMs: sessionEnd - sessionStart,
          totalMs: sessionEnd - started,
          sourceChars: options.source.length,
          stepCount: trajectory.steps.length,
        },
      })
    } catch (error) {
      // Isolated per session: the loop used to sit inside one try, so a single
      // bad session failed the whole file and discarded the good ones with it.
      issues.push({
        index,
        label: trajectory.label,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Nothing usable is still a failure — "I analysed your file" must not be
  // claimed when every session in it was dropped.
  if (sessions.length === 0 && issues.length > 0) {
    return fail('analysis-failed', '分析过程出错', {
      reason: issues[0]?.message ?? '未知错误',
      label: options.label,
    })
  }

  return ok({ sessions, issues })
}

/** The one place a score comes from: trajectory + metrics + pack → score card.
 *
 *  Rules are evaluated on every call, so a pack edit is reflected with no
 *  recompute step to forget. Measured cost is ~10ms for a 10k-step trajectory
 *  (parsing alone costs ~39ms), so callers memoise on (session, pack,
 *  annotations) rather than caching findings.
 *
 *  Order of findings is stable: rule findings, then manual annotations, then
 *  externally sourced findings (semantic review).
 */
export function buildCard(
  trajectory: Trajectory,
  metrics: TrajectoryMetrics,
  pack: RulePack,
  annotations: Annotation[] = [],
  extra: Finding[] = [],
): ScoreCard {
  const manual = annotationFindings(trajectory.id, annotations)

  let run: { findings: Finding[]; ruleIssues: RuleIssue[] }
  try {
    run = runRules(trajectory, pack, metrics)
  } catch (error) {
    // A pack used from the main thread must not take the panel down with it.
    // Degrading to "no rule findings" keeps the session usable and surfaces the
    // failure where the user already looks for it: the rule-issues list.
    run = {
      findings: [],
      ruleIssues: [{ ruleId: 'engine', message: error instanceof Error ? error.message : String(error) }],
    }
  }

  return scoreTrajectory([...run.findings, ...manual, ...extra], pack.dimensions, run.ruleIssues)
}

/** Score an analysed session under a pack, with optional manual annotations. */
export function scoreSession(
  analysis: SessionAnalysis,
  pack: RulePack,
  annotations: Annotation[] = [],
  /** 外部来源的 findings（如语义复核）。放在最后，规则与标注顺序不变。 */
  extra: Finding[] = [],
): ScoreCard {
  return buildCard(analysis.trajectory, analysis.metrics, pack, annotations, extra)
}

export type { Finding, RuleIssue }
