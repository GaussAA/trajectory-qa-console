import { describe, expect, it } from 'vitest'
import { analyze, type SessionAnalysis } from '../core/analysis'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { buildDiagnostics, buildReportBundle } from './exporters'
import { createInitialState, scoreCards, workspaceReducer } from './workspace'

const TRACE = JSON.stringify([
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '查一下' },
  { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":' } }] },
])

function fixtureState() {
  const result = analyze({ source: TRACE, label: 'trace.json', pack: DEFAULT_PACK, idPrefix: 'export' })
  if (!result.ok) throw new Error(result.error.message)
  const analysis = result.value[0] as SessionAnalysis
  const state = workspaceReducer(createInitialState(DEFAULT_PACK), {
    type: 'ingest/success',
    sessions: [analysis],
    issues: [],
  })
  return { state, cards: scoreCards(state.sessions, state.pack, state.annotations) }
}

describe('exporters', () => {
  it('builds a markdown report and a json report from the same state', () => {
    const { state, cards } = fixtureState()
    const bundle = buildReportBundle(state, cards, { generatedAt: new Date('2026-10-22T12:00:00Z') })

    expect(bundle.markdown).toContain('# 轨迹质检报告')
    expect(bundle.markdown).toContain('trace.json')
    expect(bundle.markdown).toContain('问题清单')

    const json = JSON.parse(bundle.json)
    expect(json.sessions).toHaveLength(1)
    expect(json.sessions[0].score).toBe(cards.get(state.sessions[0]!.id)?.overall)
  })

  it('follows the requested locale in both formats', () => {
    const { state, cards } = fixtureState()
    const bundle = buildReportBundle(state, cards, { locale: 'en' })

    expect(bundle.markdown.startsWith('# Trajectory QA Report')).toBe(true)
    expect(JSON.parse(bundle.json).locale).toBe('en')
  })

  it('builds a diagnostics bundle with timings, issues and events', () => {
    const { state, cards } = fixtureState()
    const diagnostics = JSON.parse(
      buildDiagnostics(
        state,
        cards,
        [{ seq: 1, at: 0, level: 'info', name: 'test' }],
        new Date('2026-10-22T12:00:00Z'),
      ),
    )

    expect(diagnostics.sessions[0].diagnostics.stepCount).toBe(3)
    expect(diagnostics.sessions[0].score).toBeTypeOf('number')
    expect(diagnostics.events).toHaveLength(1)
    expect(diagnostics.rulePack.rules).toBe(DEFAULT_PACK.rules.length)
  })
})
