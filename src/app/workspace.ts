/** Workspace state machine — all session/selection transitions in one pure place.
 *
 *  Invariants the reducer maintains:
 *    - `selectedId` is null or points at an existing session;
 *    - `selectedStep` is null or a valid step index of the selected session;
 *    - cards are derived, never stored, so annotations and pack edits cannot
 *      leave a stale score behind.
 */

import { scoreSession, type ScoreCard, type SessionAnalysis } from '../core/analysis'
import type { Annotation, AppError, PackVariant, RulePack, SessionNote, Trajectory } from '../core/model'
import type { IngestIssue } from './ingest'

export type WorkspacePhase = 'idle' | 'loading' | 'ready'

export interface WorkspaceState {
  phase: WorkspacePhase
  sessions: SessionAnalysis[]
  selectedId: string | null
  selectedStep: number | null
  pack: RulePack
  annotations: Annotation[]
  /** 会话重命名与备注，按 trajectory.id 索引（重新导入同一份轨迹仍生效）。 */
  notes: SessionNote[]
  /** 已保存的规则包变体与当前生效者；清理工作区不清掉它们——变体是口径库。 */
  variants: PackVariant[]
  activeVariantId: string | null
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
  | { type: 'variant/save'; variant: PackVariant }
  | { type: 'variant/apply'; id: string }
  | { type: 'variant/rename'; id: string; name: string }
  | { type: 'variant/import'; variants: PackVariant[] }
  | { type: 'variant/remove'; id: string }
  | { type: 'annotation/add'; annotation: Annotation }
  | { type: 'annotation/remove'; id: string }
  | { type: 'note/set'; note: SessionNote }
  | { type: 'note/batch'; notes: SessionNote[] }
  | { type: 'note/clear'; trajectoryId: string }
  | { type: 'session/remove'; ids: string[] }

/** 判断当前包是否就是某个变体存的包：变体保存后未被手改即视为「生效中」。 */
function samePack(a: RulePack, b: RulePack): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 展示名：用户起的名字优先，否则回退文件名。 */
export function labelOf(notes: SessionNote[], trajectory: Trajectory): string {
  const name = notes.find((note) => note.trajectoryId === trajectory.id)?.name
  return name && name.trim() !== '' ? name : trajectory.label
}

export function noteOf(notes: SessionNote[], trajectory: Trajectory): SessionNote | undefined {
  return notes.find((note) => note.trajectoryId === trajectory.id)
}

export function createInitialState(
  pack: RulePack,
  annotations: Annotation[] = [],
  sessions: SessionAnalysis[] = [],
  notes: SessionNote[] = [],
  variants: PackVariant[] = [],
): WorkspaceState {
  const activeVariantId = variants.find((variant) => samePack(variant.pack, pack))?.id ?? null
  const first = sessions[0] ?? null
  return {
    phase: sessions.length > 0 ? 'ready' : 'idle',
    sessions,
    selectedId: first?.id ?? null,
    selectedStep: first ? pickStepFor(first, scoreSession(first, pack.dimensions, annotations)) : null,
    pack,
    annotations,
    notes,
    variants,
    activeVariantId,
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
        notes: [],
        issues: [],
        phase: 'idle',
        lastError: null,
      }

    case 'pack/apply':
      // 经抽屉改包 = 脱离变体口径：标记为「未对齐」，列表里不再高亮。
      return { ...state, pack: action.pack, activeVariantId: null }

    case 'variant/save': {
      const rest = state.variants.filter((variant) => variant.id !== action.variant.id)
      // 新存的存到最前：最近调的口径最先看到。
      return {
        ...state,
        variants: [action.variant, ...rest],
        pack: action.variant.pack,
        activeVariantId: action.variant.id,
      }
    }

    case 'variant/apply': {
      const variant = state.variants.find((item) => item.id === action.id)
      if (!variant) return state
      return { ...state, pack: variant.pack, activeVariantId: variant.id }
    }

    case 'variant/rename': {
      const name = action.name.trim()
      if (name === '') return state
      const target = state.variants.find((variant) => variant.id === action.id)
      if (!target || target.name === name) return state
      return {
        ...state,
        variants: state.variants.map((variant) =>
          variant.id === action.id ? { ...variant, name } : variant,
        ),
      }
    }

    case 'variant/import': {
      // 导入置顶（刚带来的最显眼），同 id 覆盖：文件是权威口径。
      if (action.variants.length === 0) return state
      const ids = new Set(action.variants.map((variant) => variant.id))
      const rest = state.variants.filter((variant) => !ids.has(variant.id))
      return { ...state, variants: [...action.variants, ...rest] }
    }

    case 'variant/remove': {
      const variants = state.variants.filter((variant) => variant.id !== action.id)
      if (variants.length === state.variants.length) return state
      return {
        ...state,
        variants,
        // 删掉的是生效者：包保持现状（它仍是合法口径），只是不再标「来自变体」。
        activeVariantId: state.activeVariantId === action.id ? null : state.activeVariantId,
      }
    }

    case 'annotation/add': {
      const session = state.sessions.find((item) => item.trajectory.id === action.annotation.trajectoryId)
      if (!session) return state
      return { ...state, annotations: [...state.annotations, action.annotation] }
    }

    case 'annotation/remove':
      return { ...state, annotations: state.annotations.filter((item) => item.id !== action.id) }

    case 'note/set': {
      const name = action.note.name.trim()
      const note = action.note.note.trim()
      const rest = state.notes.filter((item) => item.trajectoryId !== action.note.trajectoryId)
      // 两个字段都清空等于「恢复原名」，顺手把记录也删掉，避免脏数据堆积。
      if (name === '' && note === '') return { ...state, notes: rest }
      return { ...state, notes: [...rest, { trajectoryId: action.note.trajectoryId, name, note }] }
    }

    case 'note/batch': {
      // 一次合并多条：先按 id 去脏，再统一 trim；空值代表「这条不要名字了」。
      const incoming = new Map<string, SessionNote>()
      const blanked = new Set<string>()
      for (const note of action.notes) {
        const name = note.name.trim()
        const text = note.note.trim()
        if (name === '' && text === '') {
          incoming.delete(note.trajectoryId)
          blanked.add(note.trajectoryId)
        } else {
          blanked.delete(note.trajectoryId)
          incoming.set(note.trajectoryId, { trajectoryId: note.trajectoryId, name, note: text })
        }
      }
      const rest = state.notes.filter(
        (item) => !incoming.has(item.trajectoryId) && !blanked.has(item.trajectoryId),
      )
      return { ...state, notes: [...rest, ...incoming.values()] }
    }

    case 'note/clear':
      return { ...state, notes: state.notes.filter((item) => item.trajectoryId !== action.trajectoryId) }

    case 'session/remove': {
      if (action.ids.length === 0) return state
      const drop = new Set(action.ids)
      const sessions = state.sessions.filter((session) => !drop.has(session.id))
      if (sessions.length === state.sessions.length) return state

      const next = sessions.find((session) => session.id === state.selectedId) ?? sessions[0]
      return {
        ...state,
        sessions,
        phase: sessions.length > 0 ? state.phase : 'idle',
        selectedId: next?.id ?? null,
        selectedStep: next
          ? pickStepFor(next, scoreSession(next, state.pack.dimensions, state.annotations))
          : null,
      }
    }

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
