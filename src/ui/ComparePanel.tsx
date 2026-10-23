import { useMemo, useState } from 'react'
import type { ScoreCard, SessionAnalysis } from '../core/analysis'
import { alignSteps, compareCards, diffFindings, summarizeAlignment, type AlignStatus } from '../core/compare'
import type { Finding, SessionNote, Step } from '../core/model'
import { useI18n } from '../i18n'
import { downloadFile, nowStamp } from '../lib/format'
import { buildComparisonReport } from '../lib/report'
import { buildComparisonHtml } from '../lib/comparison-html'
import type { MessageKey } from '../i18n'
import { cx, truncate } from '../lib/format'
import { Icon } from './Icons'

interface Props {
  sessions: SessionAnalysis[]
  cards: Map<string, ScoreCard>
  /** 用户自定义的名称：对比里也要用同一套称呼。 */
  notes?: SessionNote[]
  initialBaseId: string | null
  onClose: () => void
}

const MAX_ROWS = 80

const STATUS_KEY: Record<AlignStatus, MessageKey> = {
  same: 'compare.status.same',
  changed: 'compare.status.changed',
  added: 'compare.status.added',
  removed: 'compare.status.removed',
}

function signed(value: number): string {
  if (value === 0) return '0'
  return value > 0 ? `+${value}` : String(value)
}

function preview(step: Step | undefined): string {
  if (!step) return ''
  const text = step.text.trim().replace(/\s+/g, ' ')
  if (text) return truncate(text, 90)
  if (step.toolCalls.length > 0) return step.toolCalls.map((call) => call.name).join(', ')
  const content = (step.result?.content ?? '').trim().replace(/\s+/g, ' ')
  return content ? truncate(content, 90) : '—'
}

export function ComparePanel({ sessions, cards, notes = [], initialBaseId, onClose }: Props) {
  const { locale, t } = useI18n()
  const firstId = initialBaseId ?? sessions[0]?.id ?? ''
  const [baseId, setBaseId] = useState(firstId)
  const [targetId, setTargetId] = useState(sessions.find((session) => session.id !== firstId)?.id ?? firstId)

  const base = sessions.find((session) => session.id === baseId) ?? sessions[0]
  const target = sessions.find((session) => session.id === targetId) ?? sessions[1] ?? sessions[0]

  const diff = useMemo(() => {
    if (!base || !target) return null
    const baseCard = cards.get(base.id)
    const targetCard = cards.get(target.id)
    if (!baseCard || !targetCard) return null
    return compareCards(
      { card: baseCard, trajectory: base.trajectory },
      { card: targetCard, trajectory: target.trajectory },
    )
  }, [base, target, cards])

  const findingDiff = useMemo(() => {
    if (!base || !target) return null
    return diffFindings(cards.get(base.id)?.findings ?? [], cards.get(target.id)?.findings ?? [])
  }, [base, target, cards])

  const alignment = useMemo(() => {
    if (!base || !target) return null
    const rows = alignSteps(base.trajectory.steps, target.trajectory.steps)
    return { rows, summary: summarizeAlignment(rows) }
  }, [base, target])

  // 只有一条轨迹时不能「自己跟自己比」——那不是对比，只是看起来像。
  if (sessions.length < 2 || !base || !target || !diff || !findingDiff || !alignment) {
    return (
      <section className="panel compare-panel glass">
        <p className="hint">{t('compare.needTwo')}</p>
      </section>
    )
  }

  const changedRows = alignment.rows.filter((row) => row.status !== 'same').slice(0, MAX_ROWS)
  const titleOf = (session: SessionAnalysis) => {
    const custom = notes.find((note) => note.trajectoryId === session.trajectory.id)?.name
    return custom && custom.trim() !== '' ? custom : session.trajectory.label
  }
  const labelOf = (id: string) => {
    const session = sessions.find((item) => item.id === id)
    return session ? titleOf(session) : id
  }
  /** 报告入口的重命名口径：与导出 bundle 保持一致。 */
  const withName = (session: SessionAnalysis, card: ScoreCard) => {
    const custom = notes.find((note) => note.trajectoryId === session.trajectory.id)?.name
    return {
      trajectory:
        custom && custom.trim() !== '' ? { ...session.trajectory, label: custom } : session.trajectory,
      card,
    }
  }

  const findingList = (items: Finding[], tone: string) => (
    <ul className="compare-finding-list">
      {items.slice(0, 6).map((finding) => (
        <li key={`${finding.id}-${finding.stepIndex ?? ''}`} className={tone}>
          <span className="mono">{finding.ruleId}</span>
          <span className="compare-finding-text">
            {finding.stepIndex !== undefined ? `#${finding.stepIndex + 1} ` : ''}
            {truncate(finding.message, 70)}
          </span>
        </li>
      ))}
    </ul>
  )

  return (
    <section className="panel compare-panel glass">
      <header className="panel-head">
        <span className="panel-title">{t('compare.title')}</span>
        <span className="panel-sub">
          {alignment.summary.changed} {t('compare.changed')} ·{' '}
          {alignment.summary.added + alignment.summary.removed} {t('compare.structural')}
        </span>
        <span className="grow" />
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            const baseCard = cards.get(base.id)
            const targetCard = cards.get(target.id)
            if (!baseCard || !targetCard) return
            const input = {
              base: withName(base, baseCard),
              target: withName(target, targetCard),
              generatedAt: new Date(),
              locale,
            }
            downloadFile(`trajectory-compare-${nowStamp()}.md`, buildComparisonReport(input), 'text/markdown')
          }}
        >
          <Icon name="download" size={12} />
          {t('compare.export')}
        </button>
        <button
          type="button"
          className="btn ghost sm"
          title={t('action.htmlHint')}
          onClick={() => {
            const baseCard = cards.get(base.id)
            const targetCard = cards.get(target.id)
            if (!baseCard || !targetCard) return
            downloadFile(
              `trajectory-compare-${nowStamp()}.html`,
              buildComparisonHtml({
                base: withName(base, baseCard),
                target: withName(target, targetCard),
                generatedAt: new Date(),
                locale,
              }),
              'text/html',
            )
          }}
        >
          <Icon name="download" size={12} />
          HTML
        </button>
        <button type="button" className="btn ghost sm" onClick={onClose}>
          <Icon name="close" size={12} />
          {t('compare.close')}
        </button>
      </header>

      <div className="compare-body">
        <div className="compare-picker">
          <label className="compare-select">
            <span>{t('compare.base')}</span>
            <select value={base.id} onChange={(event) => setBaseId(event.target.value)}>
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {titleOf(session)}
                </option>
              ))}
            </select>
          </label>
          <span className="compare-arrow">→</span>
          <label className="compare-select">
            <span>{t('compare.target')}</span>
            <select value={target.id} onChange={(event) => setTargetId(event.target.value)}>
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {titleOf(session)}
                </option>
              ))}
            </select>
          </label>
          <span className="grow" />
          <div className="compare-overall">
            <span className="compare-score-before">{diff.overall.before}</span>
            <span className="compare-score-arrow">→</span>
            <span className="compare-score-after">{diff.overall.after}</span>
            <span className={cx('compare-delta', diff.overall.delta >= 0 ? 'up' : 'down')}>
              {signed(diff.overall.delta)}
            </span>
          </div>
        </div>

        <div className="compare-columns">
          <div className="compare-block">
            <h4>{t('compare.dimensions')}</h4>
            <div className="compare-dim">
              {diff.dimensions.map((dimension) => (
                <div key={dimension.id} className="compare-dim-row">
                  <span className="compare-dim-name">{dimension.label}</span>
                  <span className="compare-dim-scores">
                    {dimension.before} → {dimension.after}
                  </span>
                  <span className={cx('compare-delta', dimension.delta >= 0 ? 'up' : 'down')}>
                    {signed(dimension.delta)}
                  </span>
                </div>
              ))}
            </div>
            <div className="compare-meta">
              <span>
                {t('compare.steps')}: {diff.steps.before} → {diff.steps.after} ({signed(diff.steps.delta)})
              </span>
              <span>
                token: {diff.tokens.before} → {diff.tokens.after} ({signed(diff.tokens.delta)})
              </span>
            </div>
          </div>

          <div className="compare-block">
            <h4>{t('compare.findings')}</h4>
            <div className="compare-chips">
              <span className="compare-chip added">
                {t('compare.added', { count: findingDiff.added.length })}
              </span>
              <span className="compare-chip resolved">
                {t('compare.resolved', { count: findingDiff.resolved.length })}
              </span>
              <span className="compare-chip persisted">
                {t('compare.persisted', { count: findingDiff.persisted.length })}
              </span>
            </div>
            {findingDiff.added.length === 0 && findingDiff.resolved.length === 0 ? (
              <p className="hint">{t('compare.none')}</p>
            ) : (
              <>
                {findingDiff.added.length > 0 && (
                  <>
                    <h5 className="compare-sub">{t('compare.added', { count: findingDiff.added.length })}</h5>
                    {findingList(findingDiff.added, 'added')}
                  </>
                )}
                {findingDiff.resolved.length > 0 && (
                  <>
                    <h5 className="compare-sub">
                      {t('compare.resolved', { count: findingDiff.resolved.length })}
                    </h5>
                    {findingList(findingDiff.resolved, 'resolved')}
                  </>
                )}
              </>
            )}
          </div>
        </div>

        <div className="compare-block compare-steps">
          <h4>
            {t('compare.stepDiff')} · {labelOf(base.id)} → {labelOf(target.id)}
          </h4>
          {changedRows.length === 0 ? (
            <p className="hint">{t('compare.none')}</p>
          ) : (
            <div className="compare-step-list">
              {changedRows.map((row, index) => (
                <div key={index} className={cx('compare-step', row.status)}>
                  <span className="compare-step-badge">{t(STATUS_KEY[row.status])}</span>
                  <span className="compare-step-index">
                    {row.before ? `#${row.before.index + 1}` : ''}
                    {row.before && row.after ? ' / ' : ''}
                    {row.after ? `#${row.after.index + 1}` : ''}
                  </span>
                  <span className="compare-step-text before">{preview(row.before)}</span>
                  <span className="compare-step-text after">{preview(row.after)}</span>
                </div>
              ))}
            </div>
          )}
          {alignment.rows.filter((row) => row.status !== 'same').length > MAX_ROWS && (
            <p className="hint">{t('compare.limit', { count: MAX_ROWS })}</p>
          )}
        </div>
      </div>
    </section>
  )
}
