import { useEffect, useRef, useState } from 'react'
import type { ScoreCard, SessionAnalysis } from '../core/analysis'
import { formatTokens } from '../core/estimate'
import type { SessionNote } from '../core/model'
import { labelOf, noteOf } from '../app/workspace'
import { useT } from '../i18n'
import { cx, GRADE_COLOR, truncate } from '../lib/format'
import { Icon } from './Icons'

interface Props {
  sessions: SessionAnalysis[]
  cards: Map<string, ScoreCard>
  notes: SessionNote[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** 保存重命名与备注；空名称 + 空备注表示恢复原名。 */
  onRename: (trajectoryId: string, name: string, note: string) => void
  onAdd: () => void
  onClear: () => void
}

export function SessionList({
  sessions,
  cards,
  notes,
  selectedId,
  onSelect,
  onRename,
  onAdd,
  onClear,
}: Props) {
  const t = useT()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftNote, setDraftNote] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId) nameRef.current?.focus()
  }, [editingId])

  const beginEdit = (session: SessionAnalysis) => {
    const existing = noteOf(notes, session.trajectory)
    setDraftName(existing?.name ?? '')
    setDraftNote(existing?.note ?? '')
    setEditingId(session.id)
  }

  const commit = (session: SessionAnalysis) => {
    onRename(session.trajectory.id, draftName, draftNote)
    setEditingId(null)
  }

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
          const name = labelOf(notes, session.trajectory)
          const note = noteOf(notes, session.trajectory)?.note ?? ''
          const editing = editingId === session.id
          // 备注占了第二行，就把步数/分数放进 title，信息不丢。
          const meta = t('session.meta', {
            steps: session.trajectory.steps.length,
            tokens: formatTokens(session.trajectory.meta.totalTokens),
            score: card?.overall ?? '—',
          })
          const title = [name, meta, note].filter(Boolean).join('\n')

          return (
            <div key={session.id} className="session-row">
              <button
                type="button"
                className={cx('session-item', session.id === selectedId && 'active')}
                onClick={() => onSelect(session.id)}
                onDoubleClick={() => beginEdit(session)}
                title={title}
                aria-current={session.id === selectedId ? 'page' : undefined}
              >
                <span
                  className="session-grade"
                  style={{ color, borderColor: `${color}44`, background: `${color}12` }}
                >
                  {card?.grade ?? '—'}
                </span>
                <span className="session-copy">
                  <span className="session-name">{truncate(name, 26)}</span>
                  {note ? (
                    <span className="session-note">{truncate(note, 30)}</span>
                  ) : (
                    <span className="session-meta">{meta}</span>
                  )}
                </span>
                {card !== undefined && card.counts.error > 0 && (
                  <span className="session-badge">{card.counts.error}</span>
                )}
              </button>

              <button
                type="button"
                className="session-edit"
                onClick={() => beginEdit(session)}
                title={t('session.renameHint')}
                aria-label={t('session.rename')}
                aria-expanded={editing}
              >
                <Icon name="edit" size={12} />
              </button>

              {editing && (
                <form
                  className="session-editor"
                  onSubmit={(event) => {
                    event.preventDefault()
                    commit(session)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setEditingId(null)
                    }
                  }}
                >
                  <input
                    ref={nameRef}
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    placeholder={t('session.namePlaceholder')}
                    aria-label={t('session.name')}
                    maxLength={60}
                  />
                  <input
                    value={draftNote}
                    onChange={(event) => setDraftNote(event.target.value)}
                    placeholder={t('session.notePlaceholder')}
                    aria-label={t('session.note')}
                    maxLength={120}
                  />
                  <div className="session-editor-actions">
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => {
                        setDraftName('')
                        setDraftNote('')
                      }}
                    >
                      {t('session.resetName')}
                    </button>
                    <span className="grow" />
                    <button type="button" className="btn ghost sm" onClick={() => setEditingId(null)}>
                      {t('common.cancel')}
                    </button>
                    <button type="submit" className="btn primary sm">
                      {t('common.save')}
                    </button>
                  </div>
                </form>
              )}
            </div>
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
