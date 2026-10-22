import type { ScoreCard, SessionAnalysis } from '../core/analysis'
import { formatTokens } from '../core/estimate'
import { useT } from '../i18n'
import { cx, GRADE_COLOR, truncate } from '../lib/format'
import { Icon } from './Icons'

interface Props {
  sessions: SessionAnalysis[]
  cards: Map<string, ScoreCard>
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onClear: () => void
}

export function SessionList({ sessions, cards, selectedId, onSelect, onAdd, onClear }: Props) {
  const t = useT()

  return (
    <section className="panel session-panel glass">
      <header className="panel-head">
        <span className="panel-title">{t('session.title')}</span>
        <span className="panel-sub">{sessions.length}</span>
      </header>

      <div className="session-list">
        {sessions.map((session) => {
          const card = cards.get(session.id)
          const color = card ? (GRADE_COLOR[card.grade] ?? '#e9eef8') : '#e9eef8'
          return (
            <button
              type="button"
              key={session.id}
              className={cx('session-item', session.id === selectedId && 'active')}
              onClick={() => onSelect(session.id)}
              title={session.trajectory.label}
              aria-current={session.id === selectedId ? 'page' : undefined}
            >
              <span
                className="session-grade"
                style={{ color, borderColor: `${color}44`, background: `${color}12` }}
              >
                {card?.grade ?? '—'}
              </span>
              <span className="session-copy">
                <span className="session-name">{truncate(session.trajectory.label, 26)}</span>
                <span className="session-meta">
                  {t('session.meta', {
                    steps: session.trajectory.steps.length,
                    tokens: formatTokens(session.trajectory.meta.totalTokens),
                    score: card?.overall ?? '—',
                  })}
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
          {t('action.appendFile')}
        </button>
        <button type="button" className="btn ghost sm" onClick={onClear}>
          {t('common.clear')}
        </button>
      </footer>
    </section>
  )
}
