/** Behaviour lock for invariant 3: "a score card is always derived, never
 *  stored". These tests fail if anyone re-freezes findings into the session.
 *
 *  They also lock the equivalence of the two scoring entry points — the
 *  workspace path and the pack-comparison path — which used to be able to
 *  disagree about the same trajectory under the same pack.
 *
 *  Fixture: demo-04 (structurally broken) — 54 overall, 4 error findings,
 *  9 findings in total. Rich enough that every knob shows up in the score.
 */

import { describe, expect, it } from 'vitest'
import { analyze, buildCard, scoreSession, type SessionAnalysis } from './index'
import { scoreUnderPack } from '../pack-compare'
import { DEFAULT_PACK } from '../rules/builtin-pack'
import { SAMPLE_FILES } from '../sample'
import type { RulePack } from '../model'

/** Index of demo-04: the only sample that exercises the error gate. */
const BROKEN = 3

function sessionFor(index = BROKEN): SessionAnalysis {
  const sample = SAMPLE_FILES[index]
  if (!sample) throw new Error('missing sample')
  const result = analyze({ source: sample.content, label: sample.name, idPrefix: 'derive' })
  if (!result.ok) throw new Error(result.error.message)
  const analysis = result.value.sessions[0]
  if (!analysis) throw new Error('expected one analysis')
  return analysis
}

function withRules(pack: RulePack, patch: Partial<RulePack['rules'][number]>): RulePack {
  return { ...pack, rules: pack.rules.map((rule) => ({ ...rule, ...patch })) }
}

describe('buildCard derives from the pack, not from import time', () => {
  it('sees a rule that was disabled after the session was analysed', () => {
    const session = sessionFor()
    const before = scoreSession(session, DEFAULT_PACK)
    expect(before.findings.length).toBeGreaterThan(0)
    expect(before.capped).toBe(true)

    const after = scoreSession(session, withRules(DEFAULT_PACK, { enabled: false }))

    expect(after.findings).toHaveLength(0)
    expect(after.ruleIssues).toHaveLength(0)
    expect(after.capped).toBe(false)
    expect(after.overall).toBe(100)
    expect(after.overall).toBeGreaterThan(before.overall)
  })

  it('sees a changed score impact immediately', () => {
    const session = sessionFor()
    const before = scoreSession(session, DEFAULT_PACK)
    const after = scoreSession(session, withRules(DEFAULT_PACK, { scoreImpact: 0 }))

    // Findings are the same set, but no dimension loses points any more.
    expect(after.findings.map((finding) => finding.ruleId)).toEqual(
      before.findings.map((finding) => finding.ruleId),
    )
    expect(after.dimensions.every((dimension) => dimension.lost === 0)).toBe(true)
    expect(before.dimensions.some((dimension) => dimension.lost > 0)).toBe(true)
  })

  it('sees a changed dimension weight immediately', () => {
    const session = sessionFor()
    const before = scoreSession(session, DEFAULT_PACK)
    const skewed: RulePack = {
      ...DEFAULT_PACK,
      dimensions: DEFAULT_PACK.dimensions.map((dimension, index) =>
        index === 0 ? { ...dimension, weight: 100 } : { ...dimension, weight: 0 },
      ),
    }
    const after = scoreSession(session, skewed)

    // Findings are untouched; only the weighting moved, so the pre-gate mean
    // must move with it.
    expect(after.findings.map((finding) => finding.ruleId)).toEqual(
      before.findings.map((finding) => finding.ruleId),
    )
    expect(after.dimensions[0]?.weight).toBe(100)
    expect(after.rawOverall).not.toBe(before.rawOverall)
  })

  it('never carries a stale severity across two different packs', () => {
    const session = sessionFor()
    const strict = scoreSession(session, DEFAULT_PACK)
    const lenient = scoreSession(
      session,
      withRules(DEFAULT_PACK, { severity: 'info' as RulePack['rules'][number]['severity'] }),
    )

    expect(strict.counts.error).toBeGreaterThan(0)
    expect(strict.capped).toBe(true)

    // Same rules, softer severity: the error gate has to lift.
    expect(lenient.counts.error).toBe(0)
    expect(lenient.capped).toBe(false)
    expect(lenient.overall).toBeGreaterThan(strict.overall)
  })
})

describe('a finding outside the pack does not decide the grade', () => {
  it('keeps a ghost annotation visible but out of the counts and the gate', () => {
    const session = sessionFor()
    const clean = scoreSession(session, DEFAULT_PACK)
    const ghost = scoreSession(session, DEFAULT_PACK, [
      {
        id: 'a1',
        trajectoryId: session.trajectory.id,
        // The dimension was dropped from the pack after the annotation was made.
        dimension: 'no-such-dimension',
        severity: 'error',
        note: '这条标注指向一个已经不存在的维度',
      },
    ])

    expect(ghost.counts.error).toBe(clean.counts.error)
    expect(ghost.capped).toBe(clean.capped)
    expect(ghost.overall).toBe(clean.overall)
    // Still listed, so the user can see it stopped counting.
    expect(ghost.findings.some((finding) => finding.ruleId === 'manual')).toBe(true)
  })
})

describe('the two scoring entry points cannot disagree', () => {
  it('scoreSession and scoreUnderPack agree for every sample and pack', () => {
    for (let index = 0; index < SAMPLE_FILES.length; index += 1) {
      const session = sessionFor(index)
      const viaSession = scoreSession(session, DEFAULT_PACK)
      const viaPack = scoreUnderPack({ id: session.id, trajectory: session.trajectory }, DEFAULT_PACK)

      expect(viaPack.overall).toBe(viaSession.overall)
      expect(viaPack.grade).toBe(viaSession.grade)
      expect(viaPack.findings.map((finding) => finding.id)).toEqual(
        viaSession.findings.map((finding) => finding.id),
      )
    }
  })

  it('buildCard is pure — repeated calls give the same answer', () => {
    const session = sessionFor()
    const first = buildCard(session.trajectory, session.metrics, DEFAULT_PACK)
    const second = buildCard(session.trajectory, session.metrics, DEFAULT_PACK)
    expect(second).toEqual(first)
  })
})
