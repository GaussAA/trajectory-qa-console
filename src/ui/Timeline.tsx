import { useEffect, useMemo, useRef, useState } from 'react'
import { formatDuration, formatTokens } from '../core/estimate'
import type { ScoreCard } from '../core/analysis'
import type { Step, ToolCall, Trajectory } from '../core/model'
import { useT } from '../i18n'
import { ROLE_COLOR, cx, truncate } from '../lib/format'
import { bucketizeSteps, computeWindow } from './windowing'

interface Props {
  trajectory: Trajectory
  card: ScoreCard
  selectedStep: number | null
  onSelectStep: (index: number) => void
}

const COMPACT_THRESHOLD = 400
const COMPACT_ROW_HEIGHT = 46
const VIEWPORT_FALLBACK = 600

function callState(call: ToolCall): 'ok' | 'error' | 'pending' {
  if (!call.result) return 'pending'
  return call.result.isError ? 'error' : 'ok'
}

function previewOf(step: Step, t: ReturnType<typeof useT>): string {
  const text = step.text.trim().replace(/\s+/g, ' ')
  if (text) return truncate(text, 220)
  if (step.toolCalls.length > 0) {
    return t('timeline.callPrefix', { names: step.toolCalls.map((call) => call.name).join(', ') })
  }
  if (step.role === 'tool') {
    const content = (step.result?.content ?? '').trim().replace(/\s+/g, ' ')
    return content ? truncate(content, 220) : t('timeline.toolEmpty')
  }
  return t('common.emptyValue')
}

interface RowProps {
  step: Step
  duration?: number
  compact: boolean
  selected: boolean
  issues: { error: number; warn: number; info: number } | undefined
  maxTokens: number
  onSelect: () => void
}

/** CSS 的 `prefers-reduced-motion` 管不到 JS 触发的平滑滚动，得自己问一句。
 *  按住 ↓ 逐步查看时每一步都在做长距离动画，对晕动症用户是真实的不适。 */
function scrollBehavior(): ScrollBehavior {
  const reduce =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  return reduce ? 'auto' : 'smooth'
}

function StepRow({ step, duration, compact, selected, issues, maxTokens, onSelect }: RowProps) {
  const t = useT()
  const roleColor = ROLE_COLOR[step.role]
  const issueCount = (issues?.error ?? 0) + (issues?.warn ?? 0) + (issues?.info ?? 0)

  return (
    <button
      type="button"
      id={`step-row-${step.index}`}
      className={cx('step-row', compact && 'compact', selected && 'selected')}
      // 选中态只靠 class 的话，读屏软件不知道当前在哪一步。
      aria-current={selected ? 'step' : undefined}
      onClick={onSelect}
    >
      <span className="step-index">{String(step.index + 1).padStart(2, '0')}</span>
      <span className="step-rail" style={{ background: roleColor }} />

      <span className="step-body">
        <span className="step-line">
          <span className="role-pill" style={{ color: roleColor, background: `${roleColor}14` }}>
            {t(`role.${step.role}`)}
          </span>
          <span className="step-preview">{previewOf(step, t)}</span>
        </span>

        {!compact && (step.toolCalls.length > 0 || step.parseNotes.length > 0) && (
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
                {t('timeline.parseNotes', { count: step.parseNotes.length })}
              </span>
            )}
          </span>
        )}
      </span>

      <span
        className="step-meter"
        title={t('timeline.tokenShare', {
          pct: Math.max(1, Math.round((step.tokens.total / maxTokens) * 100)),
        })}
      >
        <span className="meter-num">{formatTokens(step.tokens.total)}</span>
        <span className="meter-bar">
          <i style={{ width: `${Math.max(4, (step.tokens.total / maxTokens) * 100)}%` }} />
        </span>
        <span className="meter-dur">{formatDuration(duration)}</span>
      </span>

      {issueCount > 0 && (
        <span className={cx('issue-badge', issues && issues.error > 0 ? 'error' : 'warn')}>
          {issues && issues.error > 0 ? issues.error : (issues?.warn ?? 0) + (issues?.info ?? 0)}
        </span>
      )}
    </button>
  )
}

export function Timeline({ trajectory, card, selectedStep, onSelectStep }: Props) {
  const t = useT()
  const compact = trajectory.steps.length > COMPACT_THRESHOLD
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: VIEWPORT_FALLBACK })

  const findingsByStep = useMemo(() => {
    const map = new Map<number, { error: number; warn: number; info: number }>()
    for (const finding of card.findings) {
      if (finding.stepIndex === undefined) continue
      const bucket = map.get(finding.stepIndex) ?? { error: 0, warn: 0, info: 0 }
      bucket[finding.severity] += 1
      map.set(finding.stepIndex, bucket)
    }
    return map
  }, [card.findings])

  const maxTokens = useMemo(
    () => Math.max(1, ...trajectory.steps.map((step) => step.tokens.total)),
    [trajectory.steps],
  )

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const read = () => {
      const height = element.clientHeight || VIEWPORT_FALLBACK
      setViewport((previous) =>
        previous.top === element.scrollTop && previous.height === height
          ? previous
          : { top: element.scrollTop, height },
      )
    }
    read()
    element.addEventListener('scroll', read, { passive: true })
    window.addEventListener('resize', read)
    return () => {
      element.removeEventListener('scroll', read)
      window.removeEventListener('resize', read)
    }
  }, [compact])

  const range = computeWindow({
    scrollTop: viewport.top,
    viewportHeight: viewport.height,
    rowHeight: COMPACT_ROW_HEIGHT,
    count: trajectory.steps.length,
  })

  useEffect(() => {
    if (selectedStep === null) return
    const element = scrollRef.current
    if (compact) {
      if (!element) return
      const height = element.clientHeight || VIEWPORT_FALLBACK
      element.scrollTo?.({
        top: Math.max(0, selectedStep * COMPACT_ROW_HEIGHT - height / 2),
        behavior: scrollBehavior(),
      })
      return
    }
    document
      .getElementById(`step-row-${selectedStep}`)
      ?.scrollIntoView?.({ block: 'center', behavior: scrollBehavior() })
  }, [selectedStep, compact])

  const buckets = useMemo(
    () =>
      bucketizeSteps({
        steps: trajectory.steps,
        maxTokens,
        hasError: (index) => (findingsByStep.get(index)?.error ?? 0) > 0,
      }),
    [trajectory.steps, maxTokens, findingsByStep],
  )

  const duration =
    trajectory.meta.startedAt !== undefined && trajectory.meta.endedAt !== undefined
      ? trajectory.meta.endedAt - trajectory.meta.startedAt
      : undefined

  const visible = compact ? trajectory.steps.slice(range.start, range.end) : trajectory.steps

  return (
    <section className="panel timeline-panel glass">
      <header className="panel-head">
        <span className="panel-title">{t('timeline.title')}</span>
        <span className="panel-sub">
          {t('score.stepUnit', { count: trajectory.steps.length })} ·{' '}
          {formatTokens(trajectory.meta.totalTokens)} {t('kpi.tokens')}
          {duration !== undefined ? ` · ${formatDuration(duration)}` : ''}
          {compact ? ` · ${t('timeline.visibleOnly')}` : ''}
        </span>
      </header>

      <div className="trace-map">
        {buckets.map((bucket) => {
          const active = selectedStep !== null && selectedStep >= bucket.start && selectedStep < bucket.end
          const span = bucket.end - bucket.start
          return (
            <button
              type="button"
              key={bucket.start}
              className={cx('map-tick', active && 'active')}
              style={{
                height: `${bucket.height}px`,
                background: bucket.error ? '#fb7185' : ROLE_COLOR[bucket.role],
              }}
              title={
                span === 1
                  ? t('timeline.stepBadge', { index: bucket.start + 1 })
                  : t('timeline.range', { start: bucket.start + 1, end: bucket.end })
              }
              aria-label={t('timeline.jumpTo', { index: bucket.start + 1 })}
              onClick={() => onSelectStep(bucket.start)}
            />
          )
        })}
      </div>

      {/* 色条原先没有任何图例：读者只能猜每种颜色对应什么角色。
          图例放在色条正下方，扫一眼就对上。 */}
      {!compact && (
        <div className="trace-legend">
          {(['system', 'user', 'assistant', 'tool'] as const).map((role) => (
            <span className="trace-legend-item" key={role}>
              <i style={{ background: ROLE_COLOR[role] }} />
              {t(`role.${role}`)}
            </span>
          ))}
          <span className="trace-legend-item">
            <i style={{ background: '#fb7185' }} />
            {t('timeline.legendError')}
          </span>
        </div>
      )}

      <div className="timeline" ref={scrollRef}>
        {compact ? (
          <div className="timeline-virtual" style={{ height: range.totalHeight }}>
            {visible.map((step, offset) => {
              const index = range.start + offset
              const next = trajectory.steps[index + 1]
              const endTimestamp = step.result?.timestamp ?? next?.timestamp
              const stepDuration =
                step.timestamp !== undefined && endTimestamp !== undefined
                  ? Math.max(0, endTimestamp - step.timestamp)
                  : undefined
              return (
                <div
                  className="virtual-row"
                  key={step.index}
                  style={{ top: index * COMPACT_ROW_HEIGHT, height: COMPACT_ROW_HEIGHT }}
                >
                  <StepRow
                    step={step}
                    duration={stepDuration}
                    compact
                    selected={step.index === selectedStep}
                    issues={findingsByStep.get(step.index)}
                    maxTokens={maxTokens}
                    onSelect={() => onSelectStep(step.index)}
                  />
                </div>
              )
            })}
          </div>
        ) : (
          trajectory.steps.map((step, i) => {
            const next = trajectory.steps[i + 1]
            const endTimestamp = step.result?.timestamp ?? next?.timestamp
            const stepDuration =
              step.timestamp !== undefined && endTimestamp !== undefined
                ? Math.max(0, endTimestamp - step.timestamp)
                : undefined
            return (
              <StepRow
                key={step.index}
                step={step}
                duration={stepDuration}
                compact={false}
                selected={step.index === selectedStep}
                issues={findingsByStep.get(step.index)}
                maxTokens={maxTokens}
                onSelect={() => onSelectStep(step.index)}
              />
            )
          })
        )}
      </div>
    </section>
  )
}
