/** The wiring layer: reducer + analyzer + persistence + telemetry.
 *
 *  UI components receive plain data and callbacks; nothing below this file knows
 *  React exists, and this file contains no layout.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ScoreCard, SessionAnalysis } from '../core/analysis'
import type { Annotation, RulePack, SessionNote, Severity } from '../core/model'
import { useI18n, type MessageKey, type TranslateParams } from '../i18n'
import { buildStressTrace } from '../core/sample'
import { createAnalyzer, type AnalyzerPort } from '../app/analyzer'
import { buildDiagnostics, buildReportBundle, downloadText } from '../app/exporters'
import { readFiles, sampleInputs, type IngestFile, type IngestIssue, type TextInput } from '../app/ingest'
import type { PersistencePort } from '../app/persistence'
import type { Telemetry, TelemetryEvent } from '../app/telemetry'
import {
  createInitialState,
  findSessionById,
  scoreCards,
  scoreFor,
  stepAt,
  workspaceReducer,
  type WorkspaceState,
} from '../app/workspace'
import { downloadFile, nowStamp } from '../lib/format'

export type ToastMessage = { key: MessageKey; params?: TranslateParams } | { text: string }

function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export interface ControllerDeps {
  analyzer?: AnalyzerPort
  telemetry: Telemetry
  persistence: PersistencePort
}

export function useWorkspaceController({ analyzer, telemetry, persistence }: ControllerDeps) {
  const initialRef = useRef<WorkspaceState | null>(null)
  if (!initialRef.current) {
    initialRef.current = createInitialState(
      persistence.loadPack(),
      persistence.loadAnnotations(),
      [],
      persistence.loadSessionNotes(),
    )
  }
  const [state, dispatch] = useReducer(workspaceReducer, initialRef.current)
  const stateRef = useRef(state)
  stateRef.current = state

  const port = useMemo(() => analyzer ?? createAnalyzer(), [analyzer])
  const abortRef = useRef<AbortController | null>(null)
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const { locale } = useI18n()
  const [events, setEvents] = useState<TelemetryEvent[]>(() => telemetry.snapshot())

  useEffect(() => telemetry.subscribe(() => setEvents(telemetry.snapshot())), [telemetry])

  useEffect(() => {
    persistence.savePack(state.pack)
  }, [state.pack, persistence])

  useEffect(() => {
    persistence.saveAnnotations(state.annotations)
  }, [state.annotations, persistence])

  useEffect(() => {
    persistence.saveSessionNotes(state.notes)
  }, [state.notes, persistence])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 3200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const cards = useMemo<Map<string, ScoreCard>>(
    () => scoreCards(state.sessions, state.pack, state.annotations),
    [state.sessions, state.pack, state.annotations],
  )

  const session = useMemo(
    () => findSessionById(state.sessions, state.selectedId),
    [state.sessions, state.selectedId],
  )
  const card = useMemo(
    () => (session ? scoreFor(session, state.pack, state.annotations) : null),
    [session, state.pack, state.annotations],
  )
  const step = useMemo(() => stepAt(session, state.selectedStep), [session, state.selectedStep])

  const totals = useMemo(() => {
    const steps = state.sessions.reduce((sum, item) => sum + item.trajectory.steps.length, 0)
    const tokens = state.sessions.reduce((sum, item) => sum + item.trajectory.meta.totalTokens, 0)
    const scores = state.sessions
      .map((item) => cards.get(item.id)?.overall)
      .filter((score): score is number => score !== undefined)
    return {
      sessions: state.sessions.length,
      steps,
      tokens,
      average:
        scores.length > 0 ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0,
    }
  }, [state.sessions, cards])

  const ingest = useCallback(
    async (inputs: TextInput[]) => {
      if (inputs.length === 0) return
      dispatch({ type: 'ingest/start' })
      const batch = uid().slice(0, 8)
      const started = Date.now()
      telemetry.emit('ingest:start', {
        files: inputs.length,
        chars: inputs.reduce((n, input) => n + input.text.length, 0),
      })

      const collected: SessionAnalysis[] = []
      const issues: IngestIssue[] = []

      for (const input of inputs) {
        const controller = new AbortController()
        abortRef.current = controller
        const result = await port.analyze(
          { text: input.text, label: input.name, pack: stateRef.current.pack, idPrefix: batch },
          controller.signal,
        )
        abortRef.current = null

        if (!result.ok) {
          if (result.error.code === 'aborted') {
            telemetry.emit('ingest:aborted', { file: input.name }, 'warn')
            dispatch({ type: 'ingest/failure', error: result.error })
            return
          }
          issues.push({ file: input.name, message: result.error.message, code: 'analysis-failed' })
          telemetry.emit('ingest:file-failed', { file: input.name, code: result.error.code }, 'error')
          continue
        }

        collected.push(...result.value)
        telemetry.emit('ingest:file', {
          file: input.name,
          sessions: result.value.length,
          steps: result.value.reduce((sum, item) => sum + item.trajectory.steps.length, 0),
          chars: input.text.length,
        })
      }

      telemetry.emit('ingest:done', {
        files: inputs.length,
        sessions: collected.length,
        issues: issues.length,
        ms: Date.now() - started,
      })

      if (collected.length === 0) {
        const message = issues[0]?.message ?? 'No usable traces'
        dispatch({ type: 'ingest/failure', error: { code: 'analysis-failed', message } })
        setToast(issues[0] ? { text: issues[0].message } : { key: 'toast.nothingUsable' })
        return
      }

      dispatch({ type: 'ingest/success', sessions: collected, issues })
      setToast(
        issues.length > 0
          ? { key: 'toast.loadedPartial', params: { loaded: collected.length, failed: issues.length } }
          : { key: 'toast.loaded', params: { count: collected.length } },
      )
    },
    [port, telemetry],
  )

  const ingestFiles = useCallback(
    async (files: IngestFile[]) => {
      const started = Date.now()
      const { inputs, issues } = await readFiles(files)
      telemetry.emit('ingest:read', {
        files: files.length,
        accepted: inputs.length,
        ms: Date.now() - started,
      })
      if (inputs.length === 0) {
        const message = issues[0]?.message ?? 'No readable files'
        dispatch({ type: 'ingest/failure', error: { code: 'analysis-failed', message } })
        setToast(issues[0] ? { text: issues[0].message } : { key: 'toast.nothingReadable' })
        return
      }
      await ingest(inputs)
    },
    [ingest, telemetry],
  )

  const loadSamples = useCallback(
    (index?: number) => {
      const inputs = sampleInputs()
      const picked =
        typeof index === 'number' && index >= 0 && index < inputs.length
          ? [inputs[index] as TextInput]
          : inputs
      void ingest(picked)
    },
    [ingest],
  )

  /** Demo/performance hook: `#stress:10000` loads a synthetic long trace. */
  const loadStress = useCallback(
    (steps = 5000) => {
      void ingest([{ name: `stress-${steps}.json`, text: buildStressTrace(steps) }])
    },
    [ingest],
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const clear = useCallback(() => {
    dispatch({ type: 'workspace/clear' })
    telemetry.emit('workspace:clear')
    setToast({ key: 'toast.cleared' })
  }, [telemetry])

  const chooseSession = useCallback((id: string) => dispatch({ type: 'session/select', id }), [])
  const chooseStep = useCallback((index: number | null) => dispatch({ type: 'step/select', index }), [])

  const applyPack = useCallback(
    (pack: RulePack) => {
      dispatch({ type: 'pack/apply', pack })
      telemetry.emit('pack:apply', { name: pack.name, rules: pack.rules.length })
      setToast({ key: 'toast.packApplied', params: { count: pack.rules.length } })
    },
    [telemetry],
  )

  const addAnnotation = useCallback(
    (stepIndex: number, dimension: string, severity: Severity, note: string) => {
      const current = findSessionById(stateRef.current.sessions, stateRef.current.selectedId)
      if (!current) return
      const annotation: Annotation = {
        id: uid(),
        trajectoryId: current.trajectory.id,
        stepIndex,
        dimension,
        severity,
        note,
      }
      dispatch({ type: 'annotation/add', annotation })
      telemetry.emit('annotation:add', { dimension, severity })
      setToast({ key: 'toast.annotationAdded' })
    },
    [telemetry],
  )

  const setSessionNotes = useCallback(
    (notes: SessionNote[]) => {
      dispatch({ type: 'note/batch', notes })
      telemetry.emit('session:notes-batch', { count: notes.length })
    },
    [telemetry],
  )

  const removeSessions = useCallback(
    (ids: string[]) => {
      dispatch({ type: 'session/remove', ids })
      telemetry.emit('session:remove', { count: ids.length })
    },
    [telemetry],
  )

  const removeAnnotation = useCallback((id: string) => {
    dispatch({ type: 'annotation/remove', id })
  }, [])

  /** 空名称 + 空备注 = 恢复原始文件名（reducer 会顺手删掉记录）。 */
  const setSessionNote = useCallback(
    (trajectoryId: string, name: string, note: string) => {
      dispatch({ type: 'note/set', note: { trajectoryId, name, note } })
      telemetry.emit('session:note', { trajectoryId, renamed: name.trim() !== '', hasNote: note.trim() !== '' })
    },
    [telemetry],
  )

  const exportMarkdown = useCallback(() => {
    if (stateRef.current.sessions.length === 0) return
    const bundle = buildReportBundle(stateRef.current, cards, { locale })
    downloadFile(`trajectory-qa-${nowStamp()}.md`, bundle.markdown, 'text/markdown')
    telemetry.emit('export:markdown', { sessions: stateRef.current.sessions.length, locale })
    setToast({ key: 'toast.reportExported' })
  }, [cards, locale, telemetry])

  const exportJson = useCallback(() => {
    if (stateRef.current.sessions.length === 0) return
    const bundle = buildReportBundle(stateRef.current, cards, { locale })
    downloadFile(`trajectory-qa-${nowStamp()}.json`, bundle.json, 'application/json')
    telemetry.emit('export:json', { sessions: stateRef.current.sessions.length, locale })
    setToast({ key: 'toast.jsonExported' })
  }, [cards, locale, telemetry])

  const exportDiagnostics = useCallback(() => {
    const content = buildDiagnostics(stateRef.current, cards, telemetry.snapshot())
    downloadText(`diagnostics-${nowStamp()}.json`, content, 'application/json')
    telemetry.emit('export:diagnostics')
    setToast({ key: 'toast.diagnosticsExported' })
  }, [cards, telemetry])

  const clearTelemetry = useCallback(() => {
    telemetry.clear()
    setEvents([])
  }, [telemetry])

  return {
    state,
    session,
    card,
    step,
    cards,
    totals,
    events,
    toast,
    dismissToast: () => setToast(null),
    actions: {
      ingestFiles,
      loadSamples,
      loadStress,
      cancel,
      clear,
      chooseSession,
      chooseStep,
      applyPack,
      addAnnotation,
      removeAnnotation,
      setSessionNote,
      setSessionNotes,
      removeSessions,
      exportMarkdown,
      exportJson,
      exportDiagnostics,
      clearTelemetry,
    },
  }
}
