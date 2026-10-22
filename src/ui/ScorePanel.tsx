import { formatDuration, formatTokens } from '../core/estimate'
import type { ScoreCard } from '../core/analysis'
import type { Trajectory } from '../core/model'
import { cx, GRADE_COLOR } from '../lib/format'

interface Props {
  card: ScoreCard
  trajectory: Trajectory
  ruleIssueCount: number
}

const RING_RADIUS = 42
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

export function ScorePanel({ card, trajectory, ruleIssueCount }: Props) {
  const gradeColor = GRADE_COLOR[card.grade] ?? '#e9eef8'
  const dash = (card.overall / 100) * CIRCUMFERENCE
  const duration =
    trajectory.meta.startedAt !== undefined && trajectory.meta.endedAt !== undefined
      ? trajectory.meta.endedAt - trajectory.meta.startedAt
      : undefined

  return (
    <section className="panel score-panel glass">
      <div className="score-main">
        <div className="ring-wrap">
          <svg width="112" height="112" viewBox="0 0 112 112" role="img" aria-label={`总分 ${card.overall}`}>
            <defs>
              <linearGradient id="score-ring" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#5eead4" />
                <stop offset="55%" stopColor="#7dd3fc" />
                <stop offset="100%" stopColor="#a78bfa" />
              </linearGradient>
            </defs>
            <circle cx="56" cy="56" r={RING_RADIUS} fill="none" stroke="rgba(148,163,184,0.14)" strokeWidth="7" />
            <circle
              cx="56"
              cy="56"
              r={RING_RADIUS}
              fill="none"
              stroke="url(#score-ring)"
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray={`${dash} ${CIRCUMFERENCE - dash}`}
              transform="rotate(-90 56 56)"
            />
            <text x="56" y="58" textAnchor="middle" fontSize="28" fontWeight="600" fill="#e9eef8">
              {card.overall}
            </text>
            <text x="56" y="76" textAnchor="middle" fontSize="11" fill="#9aa6bd">
              {card.grade} · {card.gradeLabel}
            </text>
          </svg>
        </div>

        <div className="score-body">
          <div className="score-title-row">
            <h2>{trajectory.label}</h2>
            <span className="grade-chip" style={{ color: gradeColor, borderColor: `${gradeColor}55`, background: `${gradeColor}14` }}>
              {card.grade} 级
            </span>
          </div>
          <div className="score-meta">
            <span>{trajectory.steps.length} 步</span>
            <span className="sep" />
            <span>{formatTokens(trajectory.meta.totalTokens)} tokens</span>
            <span className="sep" />
            <span>{formatDuration(duration)}</span>
            {trajectory.meta.model && (
              <>
                <span className="sep" />
                <span className="mono">{trajectory.meta.model}</span>
              </>
            )}
            {trajectory.meta.estimatedTokens && <span className="tag-dim">token 为估算</span>}
          </div>
          <div className="score-counts">
            <span className="count-pill error">{card.counts.error} 严重</span>
            <span className="count-pill warn">{card.counts.warn} 警告</span>
            <span className="count-pill info">{card.counts.info} 提示</span>
            {card.capped && (
              <span className="count-pill rule" title={`加权分 ${card.rawOverall}，因存在严重问题封顶`}>
                严重问题封顶
              </span>
            )}
            {ruleIssueCount > 0 && <span className="count-pill rule">规则异常 {ruleIssueCount}</span>}
          </div>
        </div>
      </div>

      <div className="dim-grid">
        {card.dimensions.map((dimension) => (
          <div className={cx('dim-row', dimension.findings === 0 && 'dim-clean')} key={dimension.id}>
            <span className="dim-name">
              <i style={{ background: dimension.color }} />
              {dimension.label}
              <em>{Math.round(dimension.weight * 100)}%</em>
            </span>
            <span className="dim-track">
              <span style={{ width: `${dimension.score}%`, background: dimension.color }} />
            </span>
            <span className="dim-score" style={{ color: dimension.score >= 80 ? '#e9eef8' : '#fbbf24' }}>
              {dimension.score}
            </span>
            <span className="dim-issues" title="该维度问题数">
              {dimension.findings > 0 ? dimension.findings : ''}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
