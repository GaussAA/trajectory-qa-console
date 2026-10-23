import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ErrorInfo } from 'react'
import { formatTokens } from '../core/estimate'
import type { AnalyzerPort } from '../app/analyzer'
import { createPersistence, createBrowserStorage, type PersistencePort } from '../app/persistence'
import { createTelemetry, installGlobalErrorHandlers, type Telemetry } from '../app/telemetry'
import { DiagnosticsDrawer } from './DiagnosticsDrawer'
import { ComparePanel } from './ComparePanel'
import { EmptyState } from './EmptyState'
import { ErrorBoundary } from './ErrorBoundary'
import { FindingsPanel } from './FindingsPanel'
import { Icon } from './Icons'
import { Inspector } from './Inspector'
import { RuleDrawer } from './RuleDrawer'
import { ScorePanel } from './ScorePanel'
import { SessionList } from './SessionList'
import { Timeline } from './Timeline'
import { labelOf } from '../app/workspace'
import { useWorkspaceController } from './useWorkspaceController'
import { LOCALES, useI18n } from '../i18n'
import { cx } from '../lib/format'

export interface AppProps {
  analyzer?: AnalyzerPort
  telemetry?: Telemetry
  persistence?: PersistencePort
}

export default function App({
  analyzer,
  telemetry: injectedTelemetry,
  persistence: injectedPersistence,
}: AppProps = {}) {
  const telemetry = useMemo(() => injectedTelemetry ?? createTelemetry(), [injectedTelemetry])
  const persistence = useMemo(
    () => injectedPersistence ?? createPersistence(createBrowserStorage(), telemetry),
    [injectedPersistence, telemetry],
  )

  const controller = useWorkspaceController({ analyzer, telemetry, persistence })
  const { state, session, card, step, cards, totals, events, actions } = controller
  const { locale, t, setLocale } = useI18n()
  const toastText = controller.toast
    ? 'key' in controller.toast
      ? t(controller.toast.key, controller.toast.params)
      : controller.toast.text
    : null

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const canCompare = state.sessions.length >= 2
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const demoLoaded = useRef(false)

  useEffect(() => installGlobalErrorHandlers(telemetry), [telemetry])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.has('drawer')) setDrawerOpen(true)
    if (params.has('diag')) setDiagnosticsOpen(true)
    if (params.has('compare')) setCompareOpen(true)
  }, [])

  useEffect(() => {
    const hash = window.location.hash
    const demo = /^#demo(?::(\d+))?$/.exec(hash)
    const stress = /^#stress(?::(\d+))?$/.exec(hash)
    if ((!demo && !stress) || demoLoaded.current) return
    demoLoaded.current = true
    if (demo) actions.loadSamples(demo[1] ? Number(demo[1]) - 1 : undefined)
    else actions.loadStress(stress?.[1] ? Number(stress[1]) : undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const reportBoundaryError = useCallback(
    (name: string) => (error: Error, info: ErrorInfo) => {
      telemetry.emit(
        'ui:boundary',
        { panel: name, message: error.message, stack: info.componentStack?.slice(0, 600) },
        'error',
      )
    },
    [telemetry],
  )

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const files = Array.from(event.dataTransfer.files)
    if (files.length > 0) void actions.ingestFiles(files)
  }

  const onDragEnter = (event: DragEvent) => {
    event.preventDefault()
    if (!event.dataTransfer.types.includes('Files')) return
    dragDepth.current += 1
    setDragging(true)
  }

  const onDragLeave = (event: DragEvent) => {
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  const hasData = state.sessions.length > 0 && session !== null && card !== null

  return (
    <div
      className="app"
      onDragEnter={onDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="spark" size={18} />
          </span>
          <div>
            <h1>{t('app.name')}</h1>
            <span className="brand-sub">{t('app.subtitle')}</span>
          </div>
        </div>

        {hasData && (
          <div className="kpis">
            <span className="kpi">
              <b>{totals.sessions}</b>
              <span>{t('kpi.sessions')}</span>
            </span>
            <i className="kpi-sep" />
            <span className="kpi">
              <b>{totals.steps}</b>
              <span>{t('kpi.steps')}</span>
            </span>
            <i className="kpi-sep kpi-optional" />
            <span className="kpi kpi-optional">
              <b>{formatTokens(totals.tokens)}</b>
              <span>{t('kpi.tokens')}</span>
            </span>
            <i className="kpi-sep" />
            <span className="kpi">
              <b>{totals.average}</b>
              <span>{t('kpi.average')}</span>
            </span>
          </div>
        )}

        <span className="topbar-spacer" />

        {state.issues.length > 0 && (
          <button
            type="button"
            className="issue-pill"
            title={state.issues.map((issue) => `${issue.file}：${issue.message}`).join('\n')}
            onClick={() => setDiagnosticsOpen(true)}
          >
            {t('issues.filesFailed', { count: state.issues.length })}
          </button>
        )}

        <div className="lang-switch" role="group" aria-label="Language">
          {LOCALES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cx('lang-btn', locale === item.id && 'active')}
              aria-pressed={locale === item.id}
              onClick={() => setLocale(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="topbar-actions">
          <button type="button" className="btn ghost sm" onClick={() => actions.loadSamples()}>
            {t('action.samples')}
          </button>
          <button type="button" className="btn ghost sm" onClick={() => setDrawerOpen(true)}>
            <Icon name="sliders" size={13} />
            {t('action.rules')}
          </button>
          <button
            type="button"
            className={cx('btn ghost sm', compareOpen && 'active')}
            onClick={() => setCompareOpen((open) => !open)}
            disabled={!canCompare}
            aria-pressed={compareOpen}
            title={canCompare ? t('compare.title') : t('compare.needTwo')}
          >
            {t('action.compare')}
          </button>
          <button type="button" className="btn ghost sm" onClick={() => setDiagnosticsOpen(true)}>
            {t('action.diagnostics')}
          </button>
          <button type="button" className="btn ghost sm" onClick={actions.exportJson} disabled={!hasData}>
            JSON
          </button>
          <button
            type="button"
            className="btn primary sm"
            onClick={actions.exportMarkdown}
            disabled={!hasData}
          >
            <Icon name="download" size={13} />
            {t('action.exportReport')}
          </button>
        </div>
      </header>

      <input
        ref={fileRef}
        type="file"
        accept=".json,.jsonl,.txt,application/json"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (files.length > 0) void actions.ingestFiles(files)
        }}
      />

      {!hasData ? (
        <EmptyState
          onPick={() => fileRef.current?.click()}
          onSample={() => actions.loadSamples()}
          issues={state.issues}
        />
      ) : (
        <main
          className={cx('main-grid', compareOpen && canCompare && 'compare-mode')}
          aria-label={t('app.name')}
        >
          <div className="col col-left">
            <ErrorBoundary nameKey="panel.sessions" compact onError={reportBoundaryError('sessions')}>
              <SessionList
                sessions={state.sessions}
                cards={cards}
                notes={state.notes}
                selectedId={session.id}
                onSelect={actions.chooseSession}
                onRename={actions.setSessionNote}
                onAdd={() => fileRef.current?.click()}
                onClear={actions.clear}
              />
            </ErrorBoundary>
          </div>

          {compareOpen && canCompare ? (
            <ErrorBoundary nameKey="compare.title" compact onError={reportBoundaryError('compare')}>
              <ComparePanel
                sessions={state.sessions}
                cards={cards}
                notes={state.notes}
                initialBaseId={session.id}
                onClose={() => setCompareOpen(false)}
              />
            </ErrorBoundary>
          ) : (
            <>
              <div className="col col-center">
                <ErrorBoundary nameKey="panel.score" compact onError={reportBoundaryError('score')}>
                  <ScorePanel
                    card={card}
                    trajectory={session.trajectory}
                    label={labelOf(state.notes, session.trajectory)}
                    ruleIssueCount={card.ruleIssues.length}
                  />
                </ErrorBoundary>
                <ErrorBoundary nameKey="panel.timeline" compact onError={reportBoundaryError('timeline')}>
                  <Timeline
                    trajectory={session.trajectory}
                    card={card}
                    selectedStep={state.selectedStep}
                    onSelectStep={actions.chooseStep}
                  />
                </ErrorBoundary>
              </div>

              <div className="col col-right">
                <ErrorBoundary nameKey="panel.inspector" compact onError={reportBoundaryError('inspector')}>
                  <Inspector
                    trajectory={session.trajectory}
                    step={step}
                    card={card}
                    dimensions={state.pack.dimensions}
                    annotations={state.annotations}
                    onAnnotate={actions.addAnnotation}
                    onRemoveAnnotation={actions.removeAnnotation}
                  />
                </ErrorBoundary>
                <ErrorBoundary nameKey="panel.findings" compact onError={reportBoundaryError('findings')}>
                  <FindingsPanel
                    card={card}
                    dimensions={state.pack.dimensions}
                    onLocate={actions.chooseStep}
                  />
                </ErrorBoundary>
              </div>
            </>
          )}
        </main>
      )}

      <RuleDrawer
        open={drawerOpen}
        pack={state.pack}
        sessions={state.sessions}
        ruleIssues={card?.ruleIssues ?? []}
        onClose={() => setDrawerOpen(false)}
        onApply={(next) => {
          actions.applyPack(next)
          setDrawerOpen(false)
        }}
      />

      <DiagnosticsDrawer
        open={diagnosticsOpen}
        events={events}
        sessions={state.sessions}
        onClose={() => setDiagnosticsOpen(false)}
        onExport={actions.exportDiagnostics}
        onClear={actions.clearTelemetry}
      />

      {state.phase === 'loading' && (
        <div className="loading-overlay" role="status" aria-live="polite">
          <div className="loading-card glass">
            <span className="spinner" />
            <div>
              <b>{t('loading.title')}</b>
              <p>{t('loading.description')}</p>
            </div>
            <button type="button" className="btn ghost sm" onClick={actions.cancel}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {controller.toast && (
        <div className="toast" role="status" aria-live="polite">
          {toastText}
        </div>
      )}
      {dragging && (
        <div className="drag-overlay" role="presentation">
          {t('drop.overlay')}
        </div>
      )}
    </div>
  )
}
