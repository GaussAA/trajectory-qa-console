import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyze, scoreSession } from './index'
import { DEFAULT_PACK } from '../rules/builtin-pack'
import { SAMPLE_FILES } from '../sample'

/** Behaviour lock: the four demo traces must score and report exactly as they
 *  did before the refactor. Any intentional change to scoring or wording has to
 *  update this file on purpose. */
const golden = JSON.parse(
  readFileSync(new URL('../__golden__/samples.json', import.meta.url), 'utf8'),
) as unknown[]

function recordFor(sample: (typeof SAMPLE_FILES)[number]) {
  const result = analyze({
    source: sample.content,
    label: sample.name,
    idPrefix: 'golden',
  })
  if (!result.ok) throw new Error(`analyze failed: ${result.error.message}`)
  const analysis = result.value.sessions[0]
  if (!analysis) throw new Error('expected one analysis')

  const card = scoreSession(analysis, DEFAULT_PACK)
  return {
    file: sample.name,
    label: analysis.trajectory.label,
    steps: analysis.trajectory.steps.map((step) => ({
      role: step.role,
      textLen: step.text.length,
      tokens: step.tokens.total,
      forCallId: step.forCallId ?? null,
      calls: step.toolCalls.map((call) => ({
        name: call.name,
        argsValid: call.argsValid,
        hasResult: call.result !== undefined,
        isError: call.result?.isError ?? false,
      })),
    })),
    metrics: analysis.metrics,
    findings: card.findings.map((finding) => ({
      ruleId: finding.ruleId,
      dimension: finding.dimension,
      severity: finding.severity,
      stepIndex: finding.stepIndex ?? null,
      message: finding.message,
    })),
    dimensions: card.dimensions.map((dimension) => ({
      id: dimension.id,
      score: dimension.score,
      lost: dimension.lost,
      findings: dimension.findings,
    })),
    overall: card.overall,
    rawOverall: card.rawOverall,
    grade: card.grade,
    counts: card.counts,
    ruleIssues: card.ruleIssues,
  }
}

describe('golden master', () => {
  it.each(SAMPLE_FILES.map((sample, index) => [sample.name, sample, index] as const))(
    'keeps %s byte-identical to the pre-refactor behaviour',
    (_name, sample, index) => {
      expect(recordFor(sample)).toEqual(golden[index])
    },
  )

  it('reports analysis timings without changing the result', () => {
    const result = analyze({
      source: SAMPLE_FILES[0]?.content ?? '',
      label: 'timing',
      clock: (() => {
        let tick = 0
        return () => (tick += 5)
      })(),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const analysis = result.value.sessions[0]
      expect(analysis?.diagnostics.parseMs).toBe(5)
      expect(analysis?.diagnostics.metricsMs).toBeGreaterThanOrEqual(5)
      expect(analysis?.diagnostics.sourceChars).toBeGreaterThan(0)
    }
  })
})
