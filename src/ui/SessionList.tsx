import { formatTokens } from '../core/estimate'
import type { ScoreCard } from '../core/score'
import type { Trajectory } from '../core/types'
import { cx, GRADE_COLOR, truncate } from '../lib/format'
import { Icon } from './Icons'

interface Props {
  trajectories: Trajectory[]
  cards: Map<string, ScoreCard>
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onClear: () => void
}

export function SessionList({ trajectories, cards, selectedId, onSelect, onAdd, onClear }: Props) {
  return (
    <section className="panel session-panel glass">
      <header className="panel-head">
        <span className="panel-title">会话</span>
        <span className="panel-sub">{trajectories.length}</span>
      </header>

      <div className="session-list">
        {trajectories.map((trajectory) => {
          const card = cards.get(trajectory.id)
          const color = card ? (GRADE_COLOR[card.grade] ?? '#e9eef8') : '#e9eef8'
          return (
            <button
              type="button"
              key={trajectory.id}
              className={cx('session-item', trajectory.id === selectedId && 'active')}
              onClick={() => onSelect(trajectory.id)}
              title={trajectory.label}
            >
              <span
                className="session-grade"
                style={{ color, borderColor: `${color}44`, background: `${color}12` }}
              >
                {card?.grade ?? '—'}
              </span>
              <span className="session-copy">
                <span className="session-name">{truncate(trajectory.label, 26)}</span>
                <span className="session-meta">
                  {trajectory.steps.length} 步 · {formatTokens(trajectory.meta.totalTokens)} · {card?.overall ?? '—'} 分
                </span>
              </span>
              {card !== undefined && card.counts.error > 0 && (
                <span className="session-badge">{card.counts.error}</span>
              )}
            </button>
          )
        })}
      </div>

      <footer className="session-foot">
        <button type="button" className="btn subtle sm" onClick={onAdd}>
          <Icon name="plus" size={13} />
          追加文件
        </button>
        <button type="button" className="btn ghost sm" onClick={onClear}>
          清空
        </button>
      </footer>
    </section>
  )
}
