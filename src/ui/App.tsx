import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ErrorInfo } from 'react'
import { formatTokens } from '../core/estimate'
import type { AnalyzerPort } from '../app/analyzer'
import { createPersistence, createBrowserStorage, type PersistencePort } from '../app/persistence'
import { createTelemetry, installGlobalErrorHandlers, type Telemetry } from '../app/telemetry'
import { DiagnosticsDrawer } from './DiagnosticsDrawer'
import { EmptyState } from './EmptyState'
import { ErrorBoundary } from './ErrorBoundary'
import { FindingsPanel } from './FindingsPanel'
import { Icon } from './Icons'
import { Inspector } from './Inspector'
import { RuleDrawer } from './RuleDrawer'
import { ScorePanel } from './ScorePanel'
import { SessionList } from './SessionList'
import { Timeline } from './Timeline'
import { useWorkspaceController } from './useWorkspaceController'

export interface AppProps {
  analyzer?: AnalyzerPort
  telemetry?: Telemetry
  persistence?: PersistencePort
}

export default function App({ analyzer, telemetry: injectedTelemetry, persistence: injectedPersistence }: AppProps = {}) {
  const telemetry = useMemo(() => injectedTelemetry ?? createTelemetry(), [injectedTelemetry])
  const persistence = useMemo(
    () => injectedPersistence ?? createPersistence(createBrowserStorage(), telemetry),
    [injectedPersistence, telemetry],
  )

  const controller = useWorkspaceController({ analyzer, telemetry, persistence })
  const { state, session, card, step, cards, totals, events, actions } = controller

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const demoLoaded = useRef(false)

  useEffect(() => installGlobalErrorHandlers(telemetry), [telemetry])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.has('drawer')) setDrawerOpen(true)
    if (params.has('diag')) setDiagnosticsOpen(true)
  }, [])

  useEffect(() => {
    const match = /^#demo(?::(\d+))?$/.exec(window.location.hash)
    if (!match || demoLoaded.current) return
    demoLoaded.current = true
    actions.loadSamples(match[1] ? Number(match[1]) - 1 : undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (state.selectedStep === null) return
    const element = document.getElementById(`step-row-${state.selectedStep}`)
    element?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }, [state.selectedStep, state.selectedId])

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
            <h1>轨迹质检台</h1>
            <span className="brand-sub">Trajectory QA Console</span>
          </div>
        </div>

        {hasData && (
          <div className="kpis">
            <span className="kpi">
              <b>{totals.sessions}</b>
              <span>会话</span>
            </span>
            <i className="kpi-sep" />
            <span className="kpi">
              <b>{totals.steps}</b>
              <span>步骤</span>
            </span>
            <i className="kpi-sep kpi-optional" />
            <span className="kpi kpi-optional">
              <b>{formatTokens(totals.tokens)}</b>
              <span>tokens</span>
            </span>
            <i className="kpi-sep" />
            <span className="kpi">
              <b>{totals.average}</b>
              <span>平均分</span>
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
            {state.issues.length} 个文件失败
          </button>
        )}

        <div className="topbar-actions">
          <button type="button" className="btn ghost sm" onClick={() => actions.loadSamples()}>
            示例轨迹
          </button>
          <button type="button" className="btn ghost sm" onClick={() => setDrawerOpen(true)}>
            <Icon name="sliders" size={13} />
            规则包
          </button>
          <button type="button" className="btn ghost sm" onClick={() => setDiagnosticsOpen(true)}>
            诊断
          </button>
          <button type="button" className="btn ghost sm" onClick={actions.exportJson} disabled={!hasData}>
            JSON
          </button>
          <button type="button" className="btn primary sm" onClick={actions.exportMarkdown} disabled={!hasData}>
            <Icon name="download" size={13} />
            导出报告
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
        <div className="main-grid">
          <div className="col col-left">
            <ErrorBoundary name="会话面板" compact onError={reportBoundaryError('sessions')}>
              <SessionList
                sessions={state.sessions}
                cards={cards}
                selectedId={session.id}
                onSelect={actions.chooseSession}
                onAdd={() => fileRef.current?.click()}
                onClear={actions.clear}
              />
            </ErrorBoundary>
          </div>

          <div className="col col-center">
            <ErrorBoundary name="评分面板" compact onError={reportBoundaryError('score')}>
              <ScorePanel card={card} trajectory={session.trajectory} ruleIssueCount={card.ruleIssues.length} />
            </ErrorBoundary>
            <ErrorBoundary name="时间线" compact onError={reportBoundaryError('timeline')}>
              <Timeline
                trajectory={session.trajectory}
                card={card}
                selectedStep={state.selectedStep}
                onSelectStep={actions.chooseStep}
              />
            </ErrorBoundary>
          </div>

          <div className="col col-right">
            <ErrorBoundary name="检视器" compact onError={reportBoundaryError('inspector')}>
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
            <ErrorBoundary name="问题清单" compact onError={reportBoundaryError('findings')}>
              <FindingsPanel card={card} dimensions={state.pack.dimensions} onLocate={actions.chooseStep} />
            </ErrorBoundary>
          </div>
        </div>
      )}

      <RuleDrawer
        open={drawerOpen}
        pack={state.pack}
        card={card}
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
        <div className="loading-overlay">
          <div className="loading-card glass">
            <span className="spinner" />
            <div>
              <b>正在分析轨迹…</b>
              <p>解析、指标、规则与评分在本地完成；大文件会自动转入后台线程。</p>
            </div>
            <button type="button" className="btn ghost sm" onClick={actions.cancel}>
              取消
            </button>
          </div>
        </div>
      )}

      {controller.toast && <div className="toast">{controller.toast}</div>}
      {dragging && <div className="drag-overlay">松手即导入 · 全程本地解析</div>}
    </div>
  )
}
