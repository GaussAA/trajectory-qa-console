import { describe, expect, it } from 'vitest'
import { analyze, type SessionAnalysis } from '../core/analysis'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { createInitialState, pickStepFor, selectCards, workspaceReducer } from './workspace'

const TRACE = JSON.stringify([
  { role: 'user', content: '整理一下' },
  { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'fetch', arguments: '{"x":' } }] },
])

function fixture(): SessionAnalysis {
  const result = analyze({ source: TRACE, label: 'fixture.json', pack: DEFAULT_PACK, idPrefix: 'test' })
  if (!result.ok) throw new Error(result.error.message)
  const analysis = result.value[0]
  if (!analysis) throw new Error('no analysis')
  return analysis
}

describe('workspace reducer', () => {
  it('starts idle and empty', () => {
    const state = createInitialState(DEFAULT_PACK)
    expect(state.phase).toBe('idle')
    expect(state.selectedId).toBeNull()
    expect(state.selectedStep).toBeNull()
  })

  it('selects the first ingested session and lands on its offending step', () => {
    const analysis = fixture()
    const state = workspaceReducer(createInitialState(DEFAULT_PACK), {
      type: 'ingest/success',
      sessions: [analysis],
      issues: [],
    })
    expect(state.phase).toBe('ready')
    expect(state.selectedId).toBe(analysis.id)
    expect(state.selectedStep).toBe(1)
  })

  it('re-selects the offending step when switching sessions', () => {
    const first = fixture()
    const second = fixture()
    let state = workspaceReducer(createInitialState(DEFAULT_PACK), {
      type: 'ingest/success',
      sessions: [first, second],
      issues: [],
    })
    state = workspaceReducer(state, { type: 'step/select', index: 0 })
    state = workspaceReducer(state, { type: 'session/select', id: first.id })
    expect(state.selectedStep).toBe(1)
  })

  it('clamps invalid step indices instead of storing them', () => {
    const analysis = fixture()
    let state = workspaceReducer(createInitialState(DEFAULT_PACK), {
      type: 'ingest/success',
      sessions: [analysis],
      issues: [],
    })
    state = workspaceReducer(state, { type: 'step/select', index: 99 })
    expect(state.selectedStep).toBeNull()
    state = workspaceReducer(state, { type: 'step/select', index: 0 })
    expect(state.selectedStep).toBe(0)
  })

  it('counts matching annotations in the derived card and ignores unknown ones', () => {
    const analysis = fixture()
    let state = workspaceReducer(createInitialState(DEFAULT_PACK), {
      type: 'ingest/success',
      sessions: [analysis],
      issues: [],
    })
    state = workspaceReducer(state, {
      type: 'annotation/add',
      annotation: {
        id: 'a1',
        trajectoryId: analysis.trajectory.id,
        stepIndex: 0,
        dimension: 'semantic',
        severity: 'error',
        note: '答非所问',
      },
    })
    state = workspaceReducer(state, {
      type: 'annotation/add',
      annotation: {
        id: 'a2',
        trajectoryId: 'unknown',
        stepIndex: 0,
        dimension: 'semantic',
        severity: 'info',
        note: '忽略',
      },
    })

    expect(state.annotations).toHaveLength(1)
    const card = selectCards(state).get(analysis.id)
    expect(card?.findings.some((finding) => finding.manual)).toBe(true)
    expect(card?.dimensions.find((dimension) => dimension.id === 'semantic')?.findings).toBe(1)
  })

  it('clears sessions, selection and annotations together', () => {
    const analysis = fixture()
    let state = workspaceReducer(createInitialState(DEFAULT_PACK, [
      { id: 'a', trajectoryId: analysis.trajectory.id, dimension: 'semantic', severity: 'warn', note: 'x' },
    ]), { type: 'ingest/success', sessions: [analysis], issues: [] })

    state = workspaceReducer(state, { type: 'workspace/clear' })
    expect(state.sessions).toHaveLength(0)
    expect(state.annotations).toHaveLength(0)
    expect(state.selectedId).toBeNull()
    expect(state.phase).toBe('idle')
  })
})

describe('pickStepFor', () => {
  it('prefers the first offending step, then the first tool call, then the first message', () => {
    const analysis = fixture()
    const card = selectCards(createInitialState(DEFAULT_PACK, [], [analysis])).get(analysis.id)
    if (!card) throw new Error('missing card')
    expect(pickStepFor(analysis, card)).toBe(1)

    const clean = analyze({
      source: JSON.stringify([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]),
      label: 'clean.json',
      pack: DEFAULT_PACK,
    })
    if (!clean.ok) throw new Error(clean.error.message)
    const cleanAnalysis = clean.value[0] as SessionAnalysis
    const cleanCard = selectCards(createInitialState(DEFAULT_PACK, [], [cleanAnalysis])).get(cleanAnalysis.id)
    if (!cleanCard) throw new Error('missing card')
    expect(pickStepFor(cleanAnalysis, cleanCard)).toBe(1)
  })
})
