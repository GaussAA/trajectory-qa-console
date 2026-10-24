import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ErrorInfo } from 'react'
import { formatTokens } from '../core/estimate'
import type { AnalyzerPort } from '../app/analyzer'
import { issueMessageKey } from '../app/ingest'
import { createPersistence, createBrowserStorage, type PersistencePort } from '../app/persistence'
import { createTelemetry, installGlobalErrorHandlers, type Telemetry } from '../app/telemetry'
import { AgentPanel } from './AgentPanel'
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
import { readAgentTarget } from '../app/agent-client'
import { useWorkspaceController } from './useWorkspaceController'
import { LOCALES, useI18n } from '../i18n'
import { cx } from '../lib/format'
import { readLeftCollapsed, writeLeftCollapsed } from '../lib/prefs'

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
  const { state, session, card, step, cards, totals, events, actions, agentResult } = controller
  const { locale, t, setLocale } = useI18n()
  const toastText = controller.toast
    ? 'key' in controller.toast
      ? t(controller.toast.key, controller.toast.params)
      : controller.toast.text
    : null

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  // `?agent=` 只读一次：诊断是可选增强，没配就一切照旧（离线承诺不因为加了它而松动）。
  const [agentTarget] = useState(() =>
    typeof window === 'undefined' ? null : readAgentTarget(window.location.search),
  )
  const canCompare = state.sessions.length >= 2
  const [dragging, setDragging] = useState(false)
  // 左栏折叠：宽屏是用户的选择（持久化），窄屏由 CSS 自动收成图标条。
  const [leftCollapsed, setLeftCollapsed] = useState(readLeftCollapsed)
  const toggleLeftCollapsed = useCallback(() => {
    setLeftCollapsed((current) => {
      const next = !current
      writeLeftCollapsed(next)
      return next
    })
  }, [])
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

  // 稳定引用：actions 每次渲染都是新对象，直接依赖它会让监听器反复重挂。
  const chooseStep = actions.chooseStep

  // 键位导航：↑/↓（或 j/k）逐步查看。64 步的轨迹一格格点，
  // 审一遍要点十几分钟——这是效率上最大的一处欠账。
  useEffect(() => {
    if (state.sessions.length === 0) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      // 输入框里按方向键要能移动光标，不能抢；抽屉开着时也别抢。
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }
      if (drawerOpen || compareOpen || agentOpen || diagnosticsOpen) return

      // 在两头停住，不要越界：reducer 对越界的下标返回 null，于是到底再按一下选中就没了
      // （检视器清空），再按一下又从第 1 步重新开始。
      const count = session?.trajectory.steps.length ?? 0
      if (count === 0) return
      const current = state.selectedStep ?? -1
      if (event.key === 'ArrowDown' || event.key === 'j') {
        event.preventDefault()
        chooseStep(Math.min(current + 1, count - 1))
      } else if (event.key === 'ArrowUp' || event.key === 'k') {
        event.preventDefault()
        chooseStep(Math.max(current - 1, 0))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    state.sessions.length,
    session,
    state.selectedStep,
    drawerOpen,
    compareOpen,
    agentOpen,
    diagnosticsOpen,
    chooseStep,
  ])

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
    // 载入中的遮罩不拦 drag 事件，所以这里必须自己挡：否则第二次投放会与
    // 第一批交错 dispatch，先到的旧结果反而覆盖新的。
    if (files.length > 0 && state.phase !== 'loading') void actions.ingestFiles(files)
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
            title={state.issues
              .map((issue) => t(issueMessageKey(issue.code), issue.params))
              .join('\n')}
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
          <span className="topbar-sep" aria-hidden="true" />
          <button
            type="button"
            className={cx('btn ghost sm', compareOpen && 'active')}
            onClick={() => setCompareOpen((open) => !open)}
            disabled={!canCompare}
            aria-pressed={compareOpen}
            title={canCompare ? t('compare.title') : t('compare.needTwo')}
          >
            <Icon name="compare" size={13} />
            {t('action.compare')}
          </button>
          {agentTarget && (
            <button
              type="button"
              className={cx('btn ghost sm', agentOpen && 'active')}
              onClick={() => setAgentOpen(true)}
              disabled={!hasData}
              title={t('action.agentHint')}
              aria-pressed={agentOpen}
            >
              <Icon name="spark" size={13} />
              {t('action.agent')}
            </button>
          )}
          <button type="button" className="btn ghost sm" onClick={() => setDiagnosticsOpen(true)}>
            <Icon name="alert" size={13} />
            {t('action.diagnostics')}
          </button>
          <span className="topbar-sep" aria-hidden="true" />
          <button type="button" className="btn ghost sm" onClick={actions.exportJson} disabled={!hasData}>
            {t('action.json')}
          </button>
          <button
            type="button"
            className="btn ghost sm"
            onClick={actions.exportHtml}
            disabled={!hasData}
            title={t('action.htmlHint')}
          >
            {t('action.html')}
          </button>
          <button
            type="button"
            className="btn subtle sm"
            onClick={actions.exportMarkdown}
            disabled={!hasData}
          >
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
          data-left={leftCollapsed ? 'rail' : 'full'}
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
                onSetTags={actions.setSessionTags}
                onBatchRename={actions.setSessionNotes}
                onRemove={actions.removeSessions}
                onAdd={() => fileRef.current?.click()}
                onClear={actions.clear}
                collapsed={leftCollapsed}
                onToggleCollapsed={toggleLeftCollapsed}
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
                {/* 窄屏（≤1279）左栏整个收起，会话切换挪到这里。
                    会话列表只在开头选一次，而标注是反复做的动作——
                    让位给中栏，比让标注多绕一步划算。 */}
                <label className="narrow-session">
                  <span>{t('panel.sessions')}</span>
                  <select
                    value={session.id}
                    onChange={(event) => actions.chooseSession(event.target.value)}
                  >
                    {state.sessions.map((item) => (
                      <option key={item.id} value={item.id}>
                        {labelOf(state.notes, item.trajectory)}
                      </option>
                    ))}
                  </select>
                </label>
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
                  metrics={session.metrics}
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

      {/* Both drawers are large enough to be worth containing: a crash here
          used to take the whole document down with it. */}
      <ErrorBoundary nameKey="rules.title" onError={reportBoundaryError('rules')}>
        <RuleDrawer
          open={drawerOpen}
          pack={state.pack}
          sessions={state.sessions}
          ruleIssues={card?.ruleIssues ?? []}
          variants={state.variants}
          activeVariantId={state.activeVariantId}
          onSaveVariant={actions.saveVariant}
          onApplyVariant={actions.applyVariant}
          onRenameVariant={actions.renameVariant}
          onRemoveVariant={actions.removeVariant}
          onExportVariants={actions.exportVariants}
          onImportVariants={actions.importVariants}
          onClose={() => setDrawerOpen(false)}
          onApply={(next) => {
            actions.applyPack(next)
            setDrawerOpen(false)
          }}
        />
      </ErrorBoundary>

      <ErrorBoundary nameKey="agent.ui.title" onError={reportBoundaryError('agent')}>
        <AgentPanel
          open={agentOpen}
          target={agentTarget}
          sessions={state.sessions}
          pack={state.pack}
          onClose={() => setAgentOpen(false)}
          onApplyProposal={actions.adoptProposal}
          onRun={actions.receiveAgentRun}
          onExport={actions.exportAgentReport}
          restored={agentResult}
          onFinish={(info) =>
            telemetry.emit(
              'ui:agent',
              {
                ok: info.ok,
                code: info.code ?? '',
                rounds: info.rounds,
                toolCalls: info.toolCalls,
                durationMs: info.ms,
              },
              info.ok ? 'info' : 'warn',
            )
          }
        />
      </ErrorBoundary>

      <ErrorBoundary nameKey="diag.title" onError={reportBoundaryError('diagnostics')}>
        <DiagnosticsDrawer
          open={diagnosticsOpen}
          events={events}
          sessions={state.sessions}
          cards={cards}
          onClose={() => setDiagnosticsOpen(false)}
          onExport={actions.exportDiagnostics}
          onClear={actions.clearTelemetry}
        />
      </ErrorBoundary>

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
