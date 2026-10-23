import { describe, expect, it } from 'vitest'
import { analyze, type SessionAnalysis } from '../core/analysis'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import type { PackVariant } from '../core/model'
import { createInitialState, labelOf, noteOf, pickStepFor, scoreCards, workspaceReducer } from './workspace'

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

function firstSession() {
  const result = analyze({ source: TRACE, label: 'trace.json', pack: DEFAULT_PACK })
  if (!result.ok) throw new Error(result.error.message)
  return result.value[0]!
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
    const card = scoreCards(state.sessions, state.pack, state.annotations).get(analysis.id)
    expect(card?.findings.some((finding) => finding.manual)).toBe(true)
    expect(card?.dimensions.find((dimension) => dimension.id === 'semantic')?.findings).toBe(1)
  })

  it('clears sessions, selection and annotations together', () => {
    const analysis = fixture()
    let state = workspaceReducer(
      createInitialState(DEFAULT_PACK, [
        { id: 'a', trajectoryId: analysis.trajectory.id, dimension: 'semantic', severity: 'warn', note: 'x' },
      ]),
      { type: 'ingest/success', sessions: [analysis], issues: [] },
    )

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
    const card = scoreCards([analysis], DEFAULT_PACK, []).get(analysis.id)
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
    const cleanCard = scoreCards([cleanAnalysis], DEFAULT_PACK, []).get(cleanAnalysis.id)
    if (!cleanCard) throw new Error('missing card')
    expect(pickStepFor(cleanAnalysis, cleanCard)).toBe(1)
  })
})

describe('session notes and removal', () => {
  it('stores session names and trims them', () => {
    const analysis = firstSession()
    const state = createInitialState(DEFAULT_PACK, [], [analysis])

    const named = workspaceReducer(state, {
      type: 'note/set',
      note: { trajectoryId: analysis.trajectory.id, name: '  第三版  ', note: '  改了 system prompt ' },
    })
    expect(named.notes).toEqual([
      { trajectoryId: analysis.trajectory.id, name: '第三版', note: '改了 system prompt' },
    ])
    expect(labelOf(named.notes, analysis.trajectory)).toBe('第三版')
    expect(noteOf(named.notes, analysis.trajectory)?.note).toBe('改了 system prompt')
  })

  it('falls back to the file name and drops empty notes', () => {
    const analysis = firstSession()
    const state = createInitialState(DEFAULT_PACK, [], [analysis])

    expect(labelOf(state.notes, analysis.trajectory)).toBe('trace.json')

    const named = workspaceReducer(state, {
      type: 'note/set',
      note: { trajectoryId: analysis.trajectory.id, name: 'x', note: 'y' },
    })
    const cleared = workspaceReducer(named, {
      type: 'note/set',
      note: { trajectoryId: analysis.trajectory.id, name: '  ', note: '' },
    })
    expect(cleared.notes).toHaveLength(0)
  })

  it('clears notes with the rest of the workspace', () => {
    const analysis = firstSession()
    const named = workspaceReducer(createInitialState(DEFAULT_PACK, [], [analysis]), {
      type: 'note/set',
      note: { trajectoryId: analysis.trajectory.id, name: 'x', note: '' },
    })
    expect(workspaceReducer(named, { type: 'workspace/clear' }).notes).toHaveLength(0)
  })

  it('merges batch notes in one dispatch and trims them', () => {
    const state = createInitialState(DEFAULT_PACK)
    const merged = workspaceReducer(state, {
      type: 'note/batch',
      notes: [
        { trajectoryId: 'a', name: ' exp-01 ', note: ' 第三版 ' },
        { trajectoryId: 'b', name: 'exp-02', note: '' },
      ],
    })
    expect(merged.notes).toEqual([
      { trajectoryId: 'a', name: 'exp-01', note: '第三版' },
      { trajectoryId: 'b', name: 'exp-02', note: '' },
    ])
  })

  it('drops blank entries in a batch and keeps unrelated notes', () => {
    const state = createInitialState(DEFAULT_PACK, [], [], [{ trajectoryId: 'keep', name: 'keep', note: '' }])
    const merged = workspaceReducer(state, {
      type: 'note/batch',
      notes: [
        { trajectoryId: 'keep', name: '  ', note: ' ' },
        { trajectoryId: 'new', name: 'n', note: '' },
      ],
    })
    expect(merged.notes).toEqual([{ trajectoryId: 'new', name: 'n', note: '' }])
  })

  it('removes sessions and keeps the selection valid', () => {
    const sessions = ['a.json', 'b.json', 'c.json'].map((label) => {
      const parsed = analyze({ source: TRACE, label, pack: DEFAULT_PACK })
      if (!parsed.ok) throw new Error(parsed.error.message)
      return parsed.value[0]!
    })
    const state = createInitialState(DEFAULT_PACK, [], sessions)
    const selected = state.selectedId as string

    const afterRemove = workspaceReducer(state, { type: 'session/remove', ids: [selected] })
    expect(afterRemove.sessions).toHaveLength(2)
    expect(afterRemove.selectedId).not.toBe(selected)
    expect(afterRemove.sessions.some((session) => session.id === afterRemove.selectedId)).toBe(true)
    // 选中步号必须落在新会话的范围内
    const next = afterRemove.sessions.find((session) => session.id === afterRemove.selectedId)
    expect(afterRemove.selectedStep).toBeGreaterThanOrEqual(0)
    expect(afterRemove.selectedStep).toBeLessThan(next!.trajectory.steps.length)
  })

  it('goes back to the empty state when every session is removed', () => {
    const parsed = analyze({ source: TRACE, label: 'trace.json', pack: DEFAULT_PACK })
    if (!parsed.ok) throw new Error(parsed.error.message)
    const state = createInitialState(DEFAULT_PACK, [], parsed.value)
    const cleared = workspaceReducer(state, {
      type: 'session/remove',
      ids: state.sessions.map((session) => session.id),
    })
    expect(cleared.sessions).toHaveLength(0)
    expect(cleared.selectedId).toBeNull()
    expect(cleared.selectedStep).toBeNull()
    expect(cleared.phase).toBe('idle')
  })

  it('ignores removal requests for unknown ids', () => {
    const parsed = analyze({ source: TRACE, label: 'trace.json', pack: DEFAULT_PACK })
    if (!parsed.ok) throw new Error(parsed.error.message)
    const state = createInitialState(DEFAULT_PACK, [], parsed.value)
    expect(workspaceReducer(state, { type: 'session/remove', ids: ['ghost'] })).toBe(state)
    expect(workspaceReducer(state, { type: 'session/remove', ids: [] })).toBe(state)
  })
})

describe('pack variants', () => {
  const variant = (id: string, name: string): PackVariant => ({
    id,
    name,
    pack: { ...DEFAULT_PACK, name: `variant-${name}` },
    savedAt: '2026-10-23T10:00:00.000Z',
  })

  it('saves a variant, activates it and upserts by id', () => {
    const state = createInitialState(DEFAULT_PACK)
    const first = variant('v1', '严格')
    const saved = workspaceReducer(state, { type: 'variant/save', variant: first })
    expect(saved.variants.map((item) => item.id)).toEqual(['v1'])
    expect(saved.activeVariantId).toBe('v1')
    expect(saved.pack.name).toBe('variant-严格')

    // 同 id 再存 = 覆盖，且排到最前
    const updated = { ...first, name: '严格 v2' }
    const again = workspaceReducer(saved, { type: 'variant/save', variant: updated })
    expect(again.variants).toHaveLength(1)
    expect(again.variants[0]?.name).toBe('严格 v2')
  })

  it('unlinks the active variant when the pack is applied by hand', () => {
    const state = createInitialState(DEFAULT_PACK, [], [], [], [variant('v1', '严格')])
    const linked = workspaceReducer(state, { type: 'variant/apply', id: 'v1' })
    expect(linked.activeVariantId).toBe('v1')

    const edited = workspaceReducer(linked, { type: 'pack/apply', pack: DEFAULT_PACK })
    // 手改包 = 脱离变体口径，但变体本身还在
    expect(edited.activeVariantId).toBeNull()
    expect(edited.variants).toHaveLength(1)
  })

  it('keeps the current pack when the active variant is removed', () => {
    const state = createInitialState(DEFAULT_PACK, [], [], [], [variant('v1', '严格')])
    const applied = workspaceReducer(state, { type: 'variant/apply', id: 'v1' })
    const removed = workspaceReducer(applied, { type: 'variant/remove', id: 'v1' })

    expect(removed.variants).toHaveLength(0)
    expect(removed.activeVariantId).toBeNull()
    // 删变体不动包：它仍是合法口径
    expect(removed.pack.name).toBe('variant-严格')
  })

  it('survives workspace/clear — variants are a library, not scratch data', () => {
    const state = createInitialState(DEFAULT_PACK, [], [], [], [variant('v1', '严格')])
    const cleared = workspaceReducer(state, { type: 'workspace/clear' })
    expect(cleared.variants).toHaveLength(1)
    // 初始包还不是变体包：未应用前不标记生效
    expect(cleared.activeVariantId).toBeNull()
  })

  it('imports variants on top and overrides by id', () => {
    const state = createInitialState(DEFAULT_PACK, [], [], [], [variant('keep', '原有的')])
    const imported = workspaceReducer(state, {
      type: 'variant/import',
      variants: [variant('keep', '覆盖版'), variant('new', '新来的')],
    })
    // 整块置顶、同 id 覆盖：文件是权威口径
    expect(imported.variants.map((item) => item.id)).toEqual(['keep', 'new'])
    expect(imported.variants.find((item) => item.id === 'keep')?.name).toBe('覆盖版')

    expect(workspaceReducer(state, { type: 'variant/import', variants: [] })).toBe(state)
  })

  it('renames a variant in place and treats empty names as no-op', () => {
    const state = createInitialState(DEFAULT_PACK, [], [], [], [variant('v1', '严格')])
    const renamed = workspaceReducer(state, { type: 'variant/rename', id: 'v1', name: '  严格 v2 ' })
    expect(renamed.variants[0]?.name).toBe('严格 v2')

    expect(workspaceReducer(renamed, { type: 'variant/rename', id: 'v1', name: '   ' })).toBe(renamed)
    expect(workspaceReducer(renamed, { type: 'variant/rename', id: 'ghost', name: 'x' })).toBe(renamed)
    // 同名不产生新状态：订阅者不必空转
    expect(workspaceReducer(renamed, { type: 'variant/rename', id: 'v1', name: '严格 v2' })).toBe(renamed)
  })

  it('ignores unknown variant ids', () => {
    const state = createInitialState(DEFAULT_PACK, [], [], [], [variant('v1', '严格')])
    expect(workspaceReducer(state, { type: 'variant/apply', id: 'ghost' })).toBe(state)
    expect(workspaceReducer(state, { type: 'variant/remove', id: 'ghost' })).toBe(state)
  })
})
