import { useMemo, useState, type FormEvent } from 'react'
import { formatClock, formatDuration, formatTokens } from '../core/estimate'
import { computeMetrics } from '../core/analysis'
import type { Annotation, Dimension, Severity, Step, Trajectory } from '../core/model'
import { hasMessage, useI18n } from '../i18n'
import type { ScoreCard } from '../core/analysis'
import { ROLE_COLOR, SEVERITY_COLOR, cx, prettyJson, truncate } from '../lib/format'

interface Props {
  trajectory: Trajectory
  step: Step | null
  card: ScoreCard
  dimensions: Dimension[]
  annotations: Annotation[]
  onAnnotate: (stepIndex: number, dimension: string, severity: Severity, note: string) => void
  onRemoveAnnotation: (id: string) => void
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="metric">
      <span className="metric-value" style={tone ? { color: tone } : undefined}>
        {value}
      </span>
      <span className="metric-label">{label}</span>
    </div>
  )
}

export function Inspector({
  trajectory,
  step,
  card,
  dimensions,
  annotations,
  onAnnotate,
  onRemoveAnnotation,
}: Props) {
  const [dimension, setDimension] = useState('semantic')
  const [severity, setSeverity] = useState<Severity>('warn')
  const [note, setNote] = useState('')
  const metrics = useMemo(() => computeMetrics(trajectory), [trajectory])
  const { locale, t } = useI18n()

  const dimensionName = (item: Dimension) => {
    const key = `dimension.${item.id}`
    return hasMessage(locale, key) ? t(key) : item.label
  }

  if (!step) {
    return (
      <section className="panel inspector glass">
        <header className="panel-head">
          <span className="panel-title">{t('inspector.overview')}</span>
          <span className="panel-sub">{t('inspector.noSelection')}</span>
        </header>
        <div className="inspector-body">
          <div className="metric-grid">
            <Metric label={t('metrics.steps')} value={metrics.stepCount} />
            <Metric label={t('metrics.toolCalls')} value={metrics.toolCalls} />
            <Metric
              label={t('metrics.errors')}
              value={metrics.toolErrors}
              tone={metrics.toolErrors > 0 ? '#fb7185' : undefined}
            />
            <Metric label={t('metrics.errorRate')} value={`${metrics.errorRatePercent}%`} />
            <Metric
              label={t('metrics.unpaired')}
              value={metrics.unpairedCalls}
              tone={metrics.unpairedCalls > 0 ? '#fb7185' : undefined}
            />
            <Metric label={t('metrics.duplicateCalls')} value={metrics.duplicateCalls} />
            <Metric label="tokens" value={formatTokens(metrics.totalTokens)} />
            <Metric
              label={t('metrics.maxRepeat')}
              value={t('metrics.repeatTimes', { count: metrics.maxRepeatRun })}
            />
          </div>

          <div className="section">
            <h4>{t('inspector.parseNotes')}</h4>
            {trajectory.parseNotes.length === 0 ? (
              <p className="hint">{t('inspector.noParseNotes')}</p>
            ) : (
              <ul className="note-list">
                {trajectory.parseNotes.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            )}
          </div>

          <p className="hint">{t('inspector.emptyHint')}</p>
        </div>
      </section>
    )
  }

  const stepFindings = card.findings.filter((finding) => finding.stepIndex === step.index)
  const stepAnnotations = annotations.filter(
    (annotation) => annotation.trajectoryId === trajectory.id && annotation.stepIndex === step.index,
  )
  const next = trajectory.steps[step.index + 1]
  const endTimestamp = step.result?.timestamp ?? next?.timestamp
  const duration =
    step.timestamp !== undefined && endTimestamp !== undefined
      ? Math.max(0, endTimestamp - step.timestamp)
      : undefined
  const roleColor = ROLE_COLOR[step.role]

  const submitNote = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = note.trim()
    if (!trimmed) return
    onAnnotate(step.index, dimension, severity, trimmed)
    setNote('')
  }

  return (
    <section className="panel inspector glass">
      <header className="panel-head">
        <span className="panel-title">
          {t('inspector.stepTitle', { index: step.index + 1 })}
          <span className="role-pill inline" style={{ color: roleColor, background: `${roleColor}14` }}>
            {t(`role.${step.role}`)}
          </span>
        </span>
        <span className="panel-sub">
          {formatClock(step.timestamp)} · {formatDuration(duration)} · {formatTokens(step.tokens.total)} tk
        </span>
      </header>

      <div className="inspector-body">
        {step.text && (
          <div className="section">
            <h4>{t('inspector.content')}</h4>
            <pre className="text-block">{step.text}</pre>
          </div>
        )}

        {step.reasoning && (
          <details className="section collapse">
            <summary>
              {t('inspector.reasoning')} <em>{t('inspector.chars', { count: step.reasoning.length })}</em>
            </summary>
            <pre className="text-block dim">{step.reasoning}</pre>
          </details>
        )}

        {step.toolCalls.length > 0 && (
          <div className="section">
            <h4>{t('inspector.toolCalls')}</h4>
            {step.toolCalls.map((call) => {
              const state = !call.result ? 'pending' : call.result.isError ? 'error' : 'ok'
              return (
                <div className={cx('call-card', state)} key={call.id}>
                  <div className="call-head">
                    <span className="mono call-name">{call.name}</span>
                    <span className={cx('call-state', state)}>
                      {state === 'ok'
                        ? t('inspector.callOk')
                        : state === 'error'
                          ? t('inspector.callError')
                          : t('inspector.callPending')}
                    </span>
                  </div>
                  <div className="kv">{t('inspector.arguments')}</div>
                  <pre className="code-block">{prettyJson(call.args)}</pre>
                  {call.result ? (
                    <>
                      <div className="kv">{t('inspector.result')}</div>
                      <pre className={cx('code-block', call.result.isError && 'error')}>
                        {call.result.content || t('common.emptyValue')}
                      </pre>
                    </>
                  ) : (
                    <p className="hint warn-text">{t('inspector.unpaired')}</p>
                  )}
                  {!call.argsValid && <p className="hint warn-text">{t('inspector.invalidArgs')}</p>}
                  <div className="call-id mono">{call.id}</div>
                </div>
              )
            })}
          </div>
        )}

        {step.role === 'tool' && step.result && (
          <div className="section">
            <h4>{t('inspector.toolResult')}</h4>
            <pre className={cx('text-block', step.result.isError && 'error')}>
              {step.result.content || t('common.emptyValue')}
            </pre>
            <p className="hint mono">
              {t(step.result.isError ? 'inspector.errorReturn' : 'inspector.normalReturn')} ·{' '}
              {t('inspector.linkBroken', { id: step.forCallId ?? '—' })}
            </p>
          </div>
        )}

        {step.parseNotes.length > 0 && (
          <div className="section">
            <h4>{t('inspector.parseNotes')}</h4>
            <ul className="note-list">
              {step.parseNotes.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </div>
        )}

        {stepFindings.length > 0 && (
          <div className="section">
            <h4>{t('inspector.stepIssues', { count: stepFindings.length })}</h4>
            <div className="mini-findings">
              {stepFindings.map((finding) => (
                <div className="mini-finding" key={finding.id}>
                  <i style={{ background: SEVERITY_COLOR[finding.severity] }} />
                  <span>
                    <b>{finding.ruleTitle}</b>
                    <em>{finding.message}</em>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="section">
          <h4>{t('inspector.annotation')}</h4>
          {stepAnnotations.length > 0 && (
            <div className="annotation-list">
              {stepAnnotations.map((annotation) => (
                <div className="annotation" key={annotation.id}>
                  <i style={{ background: SEVERITY_COLOR[annotation.severity] }} />
                  <span>{annotation.note}</span>
                  <button
                    type="button"
                    className="icon-btn"
                    title={t('inspector.removeAnnotation')}
                    onClick={() => onRemoveAnnotation(annotation.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <form className="annotate-form" onSubmit={submitNote}>
            <select
              value={dimension}
              onChange={(event) => setDimension(event.target.value)}
              aria-label={t('inspector.annotationDimension')}
            >
              {dimensions.map((item) => (
                <option key={item.id} value={item.id}>
                  {dimensionName(item)}
                </option>
              ))}
            </select>
            <select
              value={severity}
              onChange={(event) => setSeverity(event.target.value as Severity)}
              aria-label={t('inspector.annotationSeverity')}
            >
              <option value="error">{t('severity.error')}</option>
              <option value="warn">{t('severity.warn')}</option>
              <option value="info">{t('severity.info')}</option>
            </select>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t('inspector.annotationPlaceholder')}
              aria-label={t('inspector.annotationNote')}
            />
            <button type="submit" className="btn subtle sm" disabled={!note.trim()}>
              {t('inspector.annotate')}
            </button>
          </form>
        </div>

        <details className="section collapse">
          <summary>{t('inspector.raw')}</summary>
          <pre className="code-block raw">{truncate(JSON.stringify(step.raw, null, 2), 6000)}</pre>
        </details>
      </div>
    </section>
  )
}
