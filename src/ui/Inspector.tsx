import { useMemo, useState, type FormEvent } from 'react'
import { formatClock, formatDuration, formatTokens } from '../core/estimate'
import { computeMetrics } from '../core/analysis'
import type { Annotation, Dimension, Severity, Step, Trajectory } from '../core/model'
import { SEVERITY_LABEL } from '../core/model'
import type { ScoreCard } from '../core/analysis'
import { ROLE_COLOR, ROLE_LABEL, SEVERITY_COLOR, cx, prettyJson, truncate } from '../lib/format'

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

  if (!step) {
    return (
      <section className="panel inspector glass">
        <header className="panel-head">
          <span className="panel-title">会话概览</span>
          <span className="panel-sub">未选中步骤</span>
        </header>
        <div className="inspector-body">
          <div className="metric-grid">
            <Metric label="步骤" value={metrics.stepCount} />
            <Metric label="工具调用" value={metrics.toolCalls} />
            <Metric
              label="失败"
              value={metrics.toolErrors}
              tone={metrics.toolErrors > 0 ? '#fb7185' : undefined}
            />
            <Metric label="失败率" value={`${metrics.errorRatePercent}%`} />
            <Metric
              label="未配对"
              value={metrics.unpairedCalls}
              tone={metrics.unpairedCalls > 0 ? '#fb7185' : undefined}
            />
            <Metric label="重复调用" value={metrics.duplicateCalls} />
            <Metric label="tokens" value={formatTokens(metrics.totalTokens)} />
            <Metric label="重复最长" value={`${metrics.maxRepeatRun} 次`} />
          </div>

          <div className="section">
            <h4>解析备注</h4>
            {trajectory.parseNotes.length === 0 ? (
              <p className="hint">结构完整，未产生解析告警。</p>
            ) : (
              <ul className="note-list">
                {trajectory.parseNotes.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            )}
          </div>

          <p className="hint">点击左侧任一步骤，查看消息内容、工具参数与证据。</p>
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
          第 {step.index + 1} 步
          <span className="role-pill inline" style={{ color: roleColor, background: `${roleColor}14` }}>
            {ROLE_LABEL[step.role]}
          </span>
        </span>
        <span className="panel-sub">
          {formatClock(step.timestamp)} · {formatDuration(duration)} · {formatTokens(step.tokens.total)} tk
        </span>
      </header>

      <div className="inspector-body">
        {step.text && (
          <div className="section">
            <h4>内容</h4>
            <pre className="text-block">{step.text}</pre>
          </div>
        )}

        {step.reasoning && (
          <details className="section collapse">
            <summary>
              推理过程 <em>{step.reasoning.length} 字符</em>
            </summary>
            <pre className="text-block dim">{step.reasoning}</pre>
          </details>
        )}

        {step.toolCalls.length > 0 && (
          <div className="section">
            <h4>工具调用</h4>
            {step.toolCalls.map((call) => {
              const state = !call.result ? 'pending' : call.result.isError ? 'error' : 'ok'
              return (
                <div className={cx('call-card', state)} key={call.id}>
                  <div className="call-head">
                    <span className="mono call-name">{call.name}</span>
                    <span className={cx('call-state', state)}>
                      {state === 'ok' ? '成功' : state === 'error' ? '失败' : '无结果'}
                    </span>
                  </div>
                  <div className="kv">入参</div>
                  <pre className="code-block">{prettyJson(call.args)}</pre>
                  {call.result ? (
                    <>
                      <div className="kv">返回</div>
                      <pre className={cx('code-block', call.result.isError && 'error')}>
                        {call.result.content || '（空）'}
                      </pre>
                    </>
                  ) : (
                    <p className="hint warn-text">未找到配对的 tool 结果，链路在此中断。</p>
                  )}
                  {!call.argsValid && <p className="hint warn-text">参数不是合法 JSON，已按原文保留。</p>}
                  <div className="call-id mono">{call.id}</div>
                </div>
              )
            })}
          </div>
        )}

        {step.role === 'tool' && step.result && (
          <div className="section">
            <h4>工具结果</h4>
            <pre className={cx('text-block', step.result.isError && 'error')}>
              {step.result.content || '（空）'}
            </pre>
            <p className="hint mono">
              {step.result.isError ? '错误返回' : '正常返回'} · 关联 {step.forCallId ?? '未配对'}
            </p>
          </div>
        )}

        {step.parseNotes.length > 0 && (
          <div className="section">
            <h4>解析备注</h4>
            <ul className="note-list">
              {step.parseNotes.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </div>
        )}

        {stepFindings.length > 0 && (
          <div className="section">
            <h4>本步问题 {stepFindings.length}</h4>
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
          <h4>人工标注 · 语义维度</h4>
          {stepAnnotations.length > 0 && (
            <div className="annotation-list">
              {stepAnnotations.map((annotation) => (
                <div className="annotation" key={annotation.id}>
                  <i style={{ background: SEVERITY_COLOR[annotation.severity] }} />
                  <span>{annotation.note}</span>
                  <button
                    type="button"
                    className="icon-btn"
                    title="删除标注"
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
              aria-label="标注维度"
            >
              {dimensions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <select
              value={severity}
              onChange={(event) => setSeverity(event.target.value as Severity)}
              aria-label="标注严重度"
            >
              <option value="error">{SEVERITY_LABEL.error}</option>
              <option value="warn">{SEVERITY_LABEL.warn}</option>
              <option value="info">{SEVERITY_LABEL.info}</option>
            </select>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="例如：结论无引用、答非所问、越权写入"
              aria-label="人工标注内容"
            />
            <button type="submit" className="btn subtle sm" disabled={!note.trim()}>
              标记
            </button>
          </form>
        </div>

        <details className="section collapse">
          <summary>原始数据</summary>
          <pre className="code-block raw">{truncate(JSON.stringify(step.raw, null, 2), 6000)}</pre>
        </details>
      </div>
    </section>
  )
}
