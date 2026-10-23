/** The wiring layer: reducer + analyzer + persistence + telemetry.
 *
 *  UI components receive plain data and callbacks; nothing below this file knows
 *  React exists, and this file contains no layout.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ScoreCard, SessionAnalysis } from '../core/analysis'
import type { Annotation, PackVariant, RulePack, SessionNote, Severity } from '../core/model'
import { useI18n, type MessageKey, type TranslateParams } from '../i18n'
import { buildStressTrace } from '../core/sample'
import { createAnalyzer, type AnalyzerPort } from '../app/analyzer'
import { buildDiagnostics, buildReportBundle, downloadText } from '../app/exporters'
import { MAX_PACK_VARIANTS, parsePackVariants, serializePackVariants } from '../app/persistence'
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
  /** 批次序号：后发起的一批接管，先前那批的迟到结果一律丢弃。 */
  const generationRef = useRef(0)
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

      // One controller for the whole batch: cancelling has to stop every file
      // still in flight, not merely the one being awaited.
      const controller = new AbortController()
      abortRef.current = controller
      // A newer batch supersedes an older one. Without this, two overlapping
      // ingests interleave their dispatches and the stale one wins.
      const generation = (generationRef.current += 1)
      const superseded = () => generationRef.current !== generation
      const release = () => {
        if (abortRef.current === controller) abortRef.current = null
      }

      for (const input of inputs) {
        const result = await port.analyze(
          { text: input.text, label: input.name, idPrefix: batch },
          controller.signal,
        )
        if (superseded()) return

        if (!result.ok) {
          if (result.error.code === 'aborted') {
            telemetry.emit('ingest:aborted', { file: input.name }, 'warn')
            dispatch({ type: 'ingest/failure', error: result.error })
            release()
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

      release()
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

  /** 存变体：包由调用方给定（抽屉存的是含未应用调参的草稿）。 */
  const saveVariant = useCallback(
    (name: string, pack: RulePack): PackVariant | null => {
      const trimmed = name.trim()
      if (trimmed === '') return null
      if (stateRef.current.variants.length >= MAX_PACK_VARIANTS) {
        setToast({ key: 'variants.limit', params: { count: MAX_PACK_VARIANTS } })
        return null
      }
      const variant: PackVariant = {
        id: uid(),
        name: trimmed,
        // 存深拷贝：之后手改包不该悄悄改掉已存的口径。
        pack: JSON.parse(JSON.stringify(pack)) as RulePack,
        savedAt: new Date().toISOString(),
      }
      dispatch({ type: 'variant/save', variant })
      telemetry.emit('variant:save', { name: trimmed, rules: pack.rules.length })
      setToast({ key: 'variants.saved', params: { name: trimmed } })
      return variant
    },
    [telemetry],
  )

  const applyVariant = useCallback(
    (id: string) => {
      const variant = stateRef.current.variants.find((item) => item.id === id)
      if (!variant) return
      dispatch({ type: 'variant/apply', id })
      telemetry.emit('variant:apply', { name: variant.name, rules: variant.pack.rules.length })
      setToast({ key: 'variants.applied', params: { name: variant.name } })
    },
    [telemetry],
  )

  const renameVariant = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim()
      if (trimmed === '') return
      dispatch({ type: 'variant/rename', id, name: trimmed })
      telemetry.emit('variant:rename')
      setToast({ key: 'variants.renamed', params: { name: trimmed } })
    },
    [telemetry],
  )

  const exportVariants = useCallback(() => {
    const variants = stateRef.current.variants
    if (variants.length === 0) return
    downloadFile(
      `pack-variants-${nowStamp()}.json`,
      serializePackVariants(variants),
      'application/json',
    )
    telemetry.emit('variant:export-all', { count: variants.length })
    setToast({ key: 'variants.exported', params: { count: variants.length } })
  }, [telemetry])

  /** 导入：文件内容已解析；这里管上限与合并，坏记录已在 parse 层丢掉。 */
  const importVariants = useCallback(
    (parsed: unknown) => {
      const incoming = parsePackVariants(parsed)
      if (incoming.length === 0) {
        setToast({ key: 'variants.importInvalid' })
        return
      }
      const existingIds = new Set(stateRef.current.variants.map((variant) => variant.id))
      const fresh = incoming.filter((variant) => !existingIds.has(variant.id))
      if (stateRef.current.variants.length + fresh.length > MAX_PACK_VARIANTS) {
        setToast({ key: 'variants.limit', params: { count: MAX_PACK_VARIANTS } })
        return
      }
      dispatch({ type: 'variant/import', variants: incoming })
      telemetry.emit('variant:import', { count: incoming.length })
      setToast({ key: 'variants.imported', params: { count: incoming.length } })
    },
    [telemetry],
  )

  const removeVariant = useCallback(
    (id: string) => {
      dispatch({ type: 'variant/remove', id })
      telemetry.emit('variant:remove')
    },
    [telemetry],
  )

  const setSessionTags = useCallback(
    (trajectoryId: string, tags: string[]) => {
      dispatch({ type: 'note/tags', trajectoryId, tags })
      telemetry.emit('session:tags', { trajectoryId, count: tags.length })
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
      telemetry.emit('session:note', {
        trajectoryId,
        renamed: name.trim() !== '',
        hasNote: note.trim() !== '',
      })
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

  const exportHtml = useCallback(() => {
    if (stateRef.current.sessions.length === 0) return
    const bundle = buildReportBundle(stateRef.current, cards, { locale })
    downloadFile(`trajectory-qa-${nowStamp()}.html`, bundle.html, 'text/html')
    telemetry.emit('export:html', { sessions: stateRef.current.sessions.length, locale })
    setToast({ key: 'toast.htmlExported' })
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
      setSessionTags,
      saveVariant,
      applyVariant,
      renameVariant,
      exportVariants,
      importVariants,
      removeVariant,
      removeSessions,
      exportMarkdown,
      exportJson,
      exportHtml,
      exportDiagnostics,
      clearTelemetry,
    },
  }
}
