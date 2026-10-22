/** Workspace state machine — all session/selection transitions in one pure place.
 *
 *  Invariants the reducer maintains:
 *    - `selectedId` is null or points at an existing session;
 *    - `selectedStep` is null or a valid step index of the selected session;
 *    - cards are derived, never stored, so annotations and pack edits cannot
 *      leave a stale score behind.
 */

import { scoreSession, type ScoreCard, type SessionAnalysis } from '../core/analysis'
import type { Annotation, AppError, RulePack } from '../core/model'
import type { IngestIssue } from './ingest'

export type WorkspacePhase = 'idle' | 'loading' | 'ready'

export interface WorkspaceState {
  phase: WorkspacePhase
  sessions: SessionAnalysis[]
  selectedId: string | null
  selectedStep: number | null
  pack: RulePack
  annotations: Annotation[]
  issues: IngestIssue[]
  lastError: AppError | null
}

export type WorkspaceAction =
  | { type: 'ingest/start' }
  | { type: 'ingest/success'; sessions: SessionAnalysis[]; issues: IngestIssue[] }
  | { type: 'ingest/failure'; error: AppError }
  | { type: 'session/select'; id: string }
  | { type: 'step/select'; index: number | null }
  | { type: 'workspace/clear' }
  | { type: 'pack/apply'; pack: RulePack }
  | { type: 'annotation/add'; annotation: Annotation }
  | { type: 'annotation/remove'; id: string }

export function createInitialState(
  pack: RulePack,
  annotations: Annotation[] = [],
  sessions: SessionAnalysis[] = [],
): WorkspaceState {
  const first = sessions[0] ?? null
  return {
    phase: sessions.length > 0 ? 'ready' : 'idle',
    sessions,
    selectedId: first?.id ?? null,
    selectedStep: first ? pickStepFor(first, scoreSession(first, pack.dimensions, annotations)) : null,
    pack,
    annotations,
    issues: [],
    lastError: null,
  }
}

/** Where to land when a session is opened: the first offending step, else the
 *  first tool call, else the first non-system message. */
export function pickStepFor(analysis: SessionAnalysis, card: ScoreCard): number | null {
  const offending = card.findings.find((finding) => finding.stepIndex !== undefined)
  if (offending?.stepIndex !== undefined) return offending.stepIndex

  const withCall = analysis.trajectory.steps.find((step) => step.toolCalls.length > 0)
  if (withCall) return withCall.index

  const nonSystem = analysis.trajectory.steps.find((step) => step.role !== 'system')
  if (nonSystem) return nonSystem.index

  return analysis.trajectory.steps.length > 0 ? 0 : null
}

function findSession(state: WorkspaceState, id: string | null): SessionAnalysis | undefined {
  if (!id) return undefined
  return state.sessions.find((session) => session.id === id)
}

function clampStep(state: WorkspaceState, id: string, index: number | null): number | null {
  if (index === null) return null
  const session = findSession(state, id)
  if (!session) return null
  return index >= 0 && index < session.trajectory.steps.length ? index : null
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'ingest/start':
      return { ...state, phase: 'loading', lastError: null }

    case 'ingest/success': {
      if (action.sessions.length === 0) {
        return { ...state, phase: 'ready', issues: action.issues }
      }
      const sessions = [...state.sessions, ...action.sessions]
      const first = action.sessions[0] as SessionAnalysis
      return {
        ...state,
        sessions,
        phase: 'ready',
        issues: action.issues,
        selectedId: first.id,
        selectedStep: pickStepFor(first, scoreSession(first, state.pack.dimensions, state.annotations)),
      }
    }

    case 'ingest/failure':
      return { ...state, phase: state.sessions.length > 0 ? 'ready' : 'idle', lastError: action.error }

    case 'session/select': {
      const session = findSession(state, action.id)
      if (!session) return state
      return {
        ...state,
        selectedId: action.id,
        selectedStep: pickStepFor(session, scoreSession(session, state.pack.dimensions, state.annotations)),
      }
    }

    case 'step/select':
      if (!state.selectedId) return state
      return { ...state, selectedStep: clampStep(state, state.selectedId, action.index) }

    case 'workspace/clear':
      return {
        ...state,
        sessions: [],
        selectedId: null,
        selectedStep: null,
        annotations: [],
        issues: [],
        phase: 'idle',
        lastError: null,
      }

    case 'pack/apply':
      return { ...state, pack: action.pack }

    case 'annotation/add': {
      const session = state.sessions.find((item) => item.trajectory.id === action.annotation.trajectoryId)
      if (!session) return state
      return { ...state, annotations: [...state.annotations, action.annotation] }
    }

    case 'annotation/remove':
      return { ...state, annotations: state.annotations.filter((item) => item.id !== action.id) }

    default:
      return state
  }
}

// ---------- derived state ----------

/** Focused selectors: the UI memoises on the exact slices it reads, so a step
 *  click never re-scores every session. */
export function scoreCards(
  sessions: SessionAnalysis[],
  pack: RulePack,
  annotations: Annotation[],
): Map<string, ScoreCard> {
  const cards = new Map<string, ScoreCard>()
  for (const session of sessions) {
    cards.set(session.id, scoreSession(session, pack.dimensions, annotations))
  }
  return cards
}

export function findSessionById(sessions: SessionAnalysis[], id: string | null): SessionAnalysis | null {
  if (!id) return null
  return sessions.find((session) => session.id === id) ?? null
}

export function scoreFor(session: SessionAnalysis, pack: RulePack, annotations: Annotation[]): ScoreCard {
  return scoreSession(session, pack.dimensions, annotations)
}

export function stepAt(session: SessionAnalysis | null, index: number | null) {
  if (!session || index === null) return null
  return session.trajectory.steps[index] ?? null
}
