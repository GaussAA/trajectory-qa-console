import { useEffect, useMemo, useRef, useState } from 'react'
import type { ScoreCard, SessionAnalysis } from '../core/analysis'
import { formatTokens } from '../core/estimate'
import type { SessionNote } from '../core/model'
import { labelOf, noteOf } from '../app/workspace'
import { useT } from '../i18n'
import { cx, GRADE_COLOR, truncate } from '../lib/format'
import { BATCH_DEFAULTS, buildBatchNames } from '../lib/naming'
import { Icon } from './Icons'

interface Props {
  sessions: SessionAnalysis[]
  cards: Map<string, ScoreCard>
  notes: SessionNote[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** 保存重命名与备注；三字段皆空表示恢复原名。 */
  onRename: (trajectoryId: string, name: string, note: string) => void
  /** 设置轨迹标签（组织用，不进评分与报告）。 */
  onSetTags: (trajectoryId: string, tags: string[]) => void
  /** 批量命名：一次提交多条，避免逐条 dispatch 造成多次重算。 */
  onBatchRename: (notes: SessionNote[]) => void
  /** 批量移除会话（工作区层面，不影响已落盘的数据）。 */
  onRemove: (ids: string[]) => void
  onAdd: () => void
  onClear: () => void
  /** 左栏是否折叠成图标条。窄屏会自动折叠，宽屏由用户决定。 */
  collapsed: boolean
  onToggleCollapsed: () => void
}

export function SessionList({
  sessions,
  cards,
  notes,
  selectedId,
  onSelect,
  onRename,
  onSetTags,
  onBatchRename,
  onRemove,
  onAdd,
  onClear,
  collapsed,
  onToggleCollapsed,
}: Props) {
  const t = useT()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftNote, setDraftNote] = useState('')
  const [draftTags, setDraftTags] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [batchOpen, setBatchOpen] = useState(false)
  const [prefix, setPrefix] = useState(BATCH_DEFAULTS.prefix)
  const [start, setStart] = useState(String(BATCH_DEFAULTS.start))
  const [pad, setPad] = useState(String(BATCH_DEFAULTS.pad))
  const [batchNote, setBatchNote] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (editingId) nameRef.current?.focus()
  }, [editingId])

  // 会话被移除后，残留的选中项必须清掉，否则批量操作会指向不存在的行。
  useEffect(() => {
    setPicked((prev) => {
      const alive = new Set(sessions.map((session) => session.id))
      const next = new Set([...prev].filter((id) => alive.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [sessions])

  const pickedSessions = useMemo(
    () => sessions.filter((session) => picked.has(session.id)),
    [sessions, picked],
  )

  /** 已载入会话身上的全部标签：按出现次数排序，作为筛选 chips。 */
  const allTags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const session of sessions) {
      for (const tag of noteOf(notes, session.trajectory)?.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag)
  }, [sessions, notes])

  const visibleSessions = useMemo(() => {
    const tagsOf = (session: SessionAnalysis) => noteOf(notes, session.trajectory)?.tags ?? []
    return tagFilter ? sessions.filter((session) => tagsOf(session).includes(tagFilter)) : sessions
  }, [sessions, notes, tagFilter])

  const previewNames = useMemo(
    () =>
      buildBatchNames(pickedSessions.length, {
        prefix,
        start: Number(start) || 1,
        pad: Number(pad) || 0,
      }),
    [pickedSessions.length, prefix, start, pad],
  )

  const exitSelection = () => {
    setSelecting(false)
    setPicked(new Set())
    setBatchOpen(false)
    setConfirmDelete(false)
  }

  const togglePick = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setConfirmDelete(false)
  }

  const beginEdit = (session: SessionAnalysis) => {
    const existing = noteOf(notes, session.trajectory)
    setDraftName(existing?.name ?? '')
    setDraftNote(existing?.note ?? '')
    setDraftTags((existing?.tags ?? []).join(', '))
    setEditingId(session.id)
  }

  const commit = (session: SessionAnalysis) => {
    onRename(session.trajectory.id, draftName, draftNote)
    onSetTags(
      session.trajectory.id,
      draftTags
        // 中英文逗号都收：用户在中文输入法下敲的是全角逗号。写成转义是为了不触发「硬编码中文」检查，
        // 这里不是文案，是输入解析。
        .split(/[,\uff0c]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    )
    setEditingId(null)
  }

  const applyBatch = () => {
    const payload: SessionNote[] = pickedSessions.map((session, index) => ({
      trajectoryId: session.trajectory.id,
      name: previewNames[index] ?? '',
      note: batchNote,
    }))
    onBatchRename(payload)
    exitSelection()
  }

  return (
    <section className="panel session-panel glass">
      <header className="panel-head">
        <span className="panel-title">{t('session.title')}</span>
        <span className="panel-sub">
          {tagFilter ? `${visibleSessions.length}/${sessions.length}` : sessions.length}
        </span>
        <span className="grow" />
        <button
          type="button"
          className="session-collapse"
          onClick={onToggleCollapsed}
          aria-pressed={collapsed}
          title={collapsed ? t('session.expand') : t('session.collapse')}
        >
          <Icon name="chevron" size={13} className={collapsed ? 'flip' : ''} />
        </button>
        <button
          type="button"
          className={cx('session-select-toggle', selecting && 'active')}
          onClick={() => (selecting ? exitSelection() : setSelecting(true))}
          aria-pressed={selecting}
          title={t('session.select')}
        >
          {selecting ? t('session.selectExit') : t('session.select')}
        </button>
      </header>

      {allTags.length > 0 && (
        <div className="tag-filter" role="group" aria-label={t('session.tags')}>
          <button
            type="button"
            className={cx('tag-chip', tagFilter === null && 'active')}
            aria-pressed={tagFilter === null}
            onClick={() => setTagFilter(null)}
          >
            {t('session.filterAll')}
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={cx('tag-chip', tagFilter === tag && 'active')}
              aria-pressed={tagFilter === tag}
              onClick={() => setTagFilter((current) => (current === tag ? null : tag))}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      <div className="session-list">
        {visibleSessions.map((session) => {
          const card = cards.get(session.id)
          const color = card ? (GRADE_COLOR[card.grade] ?? '#e9eef8') : '#e9eef8'
          const name = labelOf(notes, session.trajectory)
          const note = noteOf(notes, session.trajectory)?.note ?? ''
          const editing = editingId === session.id
          const checked = picked.has(session.id)
          // 备注占了第二行，就把步数/分数放进 title，信息不丢。
          const meta = t('session.meta', {
            steps: session.trajectory.steps.length,
            tokens: formatTokens(session.trajectory.meta.totalTokens),
            score: card?.overall ?? '—',
          })
          const title = [name, meta, note].filter(Boolean).join('\n')

          return (
            <div
              key={session.id}
              className={cx('session-row', selecting && 'selecting', checked && 'picked')}
            >
              {selecting && (
                <input
                  type="checkbox"
                  className="session-check"
                  checked={checked}
                  onChange={() => togglePick(session.id)}
                  aria-label={`${t('session.select')} ${name}`}
                />
              )}
              <button
                type="button"
                className={cx('session-item', session.id === selectedId && 'active')}
                onClick={() => (selecting ? togglePick(session.id) : onSelect(session.id))}
                onDoubleClick={() => {
                  if (!selecting) beginEdit(session)
                }}
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
                  {(noteOf(notes, session.trajectory)?.tags ?? []).length > 0 && (
                    <span className="session-tags">
                      {(noteOf(notes, session.trajectory)?.tags ?? []).map((tag) => (
                        <span key={tag} className="tag-chip mini">
                          {tag}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                {card !== undefined && card.counts.error > 0 && (
                  <span
                    className="session-badge"
                    title={t('session.errorBadge', { count: card.counts.error })}
                  >
                    {card.counts.error}
                  </span>
                )}
              </button>

              {!selecting && (
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
              )}

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
                  <input
                    value={draftTags}
                    onChange={(event) => setDraftTags(event.target.value)}
                    placeholder={t('session.tagsPlaceholder')}
                    aria-label={t('session.tags')}
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

      {selecting && pickedSessions.length > 0 && (
        <div className="batch-bar">
          <span className="batch-count">{t('session.selectedCount', { count: pickedSessions.length })}</span>
          <span className="grow" />
          <button type="button" className="btn ghost sm" onClick={() => setBatchOpen((open) => !open)}>
            {t('session.batchRename')}
          </button>
          <button
            type="button"
            className={cx('btn ghost sm', confirmDelete && 'danger')}
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true)
                return
              }
              onRemove(pickedSessions.map((session) => session.id))
              exitSelection()
            }}
          >
            {confirmDelete
              ? t('session.batchDeleteConfirm', { count: pickedSessions.length })
              : t('session.batchDelete')}
          </button>
        </div>
      )}

      {selecting && batchOpen && pickedSessions.length > 0 && (
        <form
          className="session-editor batch-editor"
          onSubmit={(event) => {
            event.preventDefault()
            applyBatch()
          }}
        >
          <div className="batch-labels" aria-hidden="true">
            <span>{t('session.batchPrefix')}</span>
            <span>{t('session.batchStart')}</span>
            <span>{t('session.batchPad')}</span>
          </div>
          <div className="batch-fields">
            <input
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
              placeholder={t('session.batchPrefix')}
              aria-label={t('session.batchPrefix')}
              maxLength={30}
            />
            <input
              value={start}
              onChange={(event) => setStart(event.target.value)}
              placeholder={t('session.batchStart')}
              aria-label={t('session.batchStart')}
              inputMode="numeric"
              maxLength={4}
            />
            <input
              value={pad}
              onChange={(event) => setPad(event.target.value)}
              placeholder={t('session.batchPad')}
              aria-label={t('session.batchPad')}
              inputMode="numeric"
              maxLength={2}
            />
          </div>
          <input
            value={batchNote}
            onChange={(event) => setBatchNote(event.target.value)}
            placeholder={t('session.batchNote')}
            aria-label={t('session.batchNote')}
            maxLength={120}
          />
          <p className="batch-preview">
            {t('session.batchPreview', {
              names:
                previewNames.slice(0, 3).join(t('common.listSeparator')) +
                (previewNames.length > 3 ? ` … +${previewNames.length - 3}` : ''),
            })}
          </p>
          <div className="session-editor-actions">
            <span className="grow" />
            <button type="button" className="btn ghost sm" onClick={() => setBatchOpen(false)}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn primary sm">
              {t('session.batchApply')}
            </button>
          </div>
        </form>
      )}

      <footer className="session-foot">
        <button type="button" className="btn subtle sm" onClick={onAdd} title={t('action.appendFile')}>
          <Icon name="plus" size={13} />
          <span className="btn-label">{t('action.appendFile')}</span>
        </button>
        <button type="button" className="btn ghost sm" onClick={onClear} title={t('common.clear')}>
          <Icon name="trash" size={13} />
          <span className="btn-label">{t('common.clear')}</span>
        </button>
      </footer>
    </section>
  )
}
