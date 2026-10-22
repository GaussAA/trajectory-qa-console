import { formatDuration, formatTokens } from '../core/estimate'
import type { ScoreCard } from '../core/analysis'
import type { ToolCall, Trajectory } from '../core/model'
import { ROLE_COLOR, ROLE_LABEL, cx, truncate } from '../lib/format'

interface Props {
  trajectory: Trajectory
  card: ScoreCard
  selectedStep: number | null
  onSelectStep: (index: number) => void
}

function callState(call: ToolCall): 'ok' | 'error' | 'pending' {
  if (!call.result) return 'pending'
  return call.result.isError ? 'error' : 'ok'
}

function previewOf(step: Trajectory['steps'][number]): string {
  const text = step.text.trim().replace(/\s+/g, ' ')
  if (text) return truncate(text, 220)
  if (step.toolCalls.length > 0) return `调用 ${step.toolCalls.map((call) => call.name).join('、')}`
  if (step.role === 'tool') {
    const content = (step.result?.content ?? '').trim().replace(/\s+/g, ' ')
    return content ? truncate(content, 220) : '（工具返回空内容）'
  }
  return '（空）'
}

export function Timeline({ trajectory, card, selectedStep, onSelectStep }: Props) {
  const findingsByStep = new Map<number, { error: number; warn: number; info: number }>()
  for (const finding of card.findings) {
    if (finding.stepIndex === undefined) continue
    const bucket = findingsByStep.get(finding.stepIndex) ?? { error: 0, warn: 0, info: 0 }
    bucket[finding.severity] += 1
    findingsByStep.set(finding.stepIndex, bucket)
  }

  const maxTokens = Math.max(1, ...trajectory.steps.map((step) => step.tokens.total))
  const duration =
    trajectory.meta.startedAt !== undefined && trajectory.meta.endedAt !== undefined
      ? trajectory.meta.endedAt - trajectory.meta.startedAt
      : undefined

  return (
    <section className="panel timeline-panel glass">
      <header className="panel-head">
        <span className="panel-title">时间线</span>
        <span className="panel-sub">
          {trajectory.steps.length} 步 · {formatTokens(trajectory.meta.totalTokens)} tokens
          {duration !== undefined ? ` · ${formatDuration(duration)}` : ''}
        </span>
      </header>

      <div className="trace-map">
        {trajectory.steps.map((step) => {
          const bucket = findingsByStep.get(step.index)
          const tone = bucket && bucket.error > 0 ? '#fb7185' : ROLE_COLOR[step.role]
          const height = 6 + (step.tokens.total / maxTokens) * 22
          return (
            <button
              type="button"
              key={step.index}
              className={cx('map-tick', step.index === selectedStep && 'active')}
              style={{ height: `${height}px`, background: tone }}
              title={`第 ${step.index + 1} 步 · ${ROLE_LABEL[step.role]} · ${formatTokens(step.tokens.total)} tk`}
              aria-label={`跳转到第 ${step.index + 1} 步`}
              onClick={() => onSelectStep(step.index)}
            />
          )
        })}
      </div>

      <div className="timeline">
        {trajectory.steps.map((step, i) => {
          const next = trajectory.steps[i + 1]
          const endTimestamp = step.result?.timestamp ?? next?.timestamp
          const stepDuration =
            step.timestamp !== undefined && endTimestamp !== undefined
              ? Math.max(0, endTimestamp - step.timestamp)
              : undefined
          const bucket = findingsByStep.get(step.index)
          const issues = (bucket?.error ?? 0) + (bucket?.warn ?? 0) + (bucket?.info ?? 0)
          const roleColor = ROLE_COLOR[step.role]

          return (
            <button
              type="button"
              id={`step-row-${step.index}`}
              key={step.index}
              className={cx('step-row', step.index === selectedStep && 'selected')}
              onClick={() => onSelectStep(step.index)}
            >
              <span className="step-index">{String(step.index + 1).padStart(2, '0')}</span>
              <span className="step-rail" style={{ background: roleColor }} />

              <span className="step-body">
                <span className="step-line">
                  <span className="role-pill" style={{ color: roleColor, background: `${roleColor}14` }}>
                    {ROLE_LABEL[step.role]}
                  </span>
                  <span className="step-preview">{previewOf(step)}</span>
                </span>

                {(step.toolCalls.length > 0 || step.parseNotes.length > 0) && (
                  <span className="step-tags">
                    {step.toolCalls.map((call) => {
                      const state = callState(call)
                      return (
                        <span className={cx('tool-chip', state)} key={call.id} title={call.rawArgs}>
                          <i />
                          {call.name}
                          {!call.argsValid && <b className="chip-warn">JSON</b>}
                        </span>
                      )
                    })}
                    {step.parseNotes.length > 0 && (
                      <span className="note-chip" title={step.parseNotes.join('\n')}>
                        {step.parseNotes.length} 条解析备注
                      </span>
                    )}
                  </span>
                )}
              </span>

              <span className="step-meter">
                <span className="meter-num">{formatTokens(step.tokens.total)}</span>
                <span className="meter-bar">
                  <i style={{ width: `${Math.max(4, (step.tokens.total / maxTokens) * 100)}%` }} />
                </span>
                <span className="meter-dur">{formatDuration(stepDuration)}</span>
              </span>

              {issues > 0 && (
                <span className={cx('issue-badge', bucket && bucket.error > 0 ? 'error' : 'warn')}>
                  {bucket && bucket.error > 0 ? bucket.error : (bucket?.warn ?? 0) + (bucket?.info ?? 0)}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </section>
  )
}
