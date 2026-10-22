import { useMemo, useState } from 'react'
import type { Dimension, Severity } from '../core/model'
import type { ScoreCard } from '../core/analysis'
import { hasMessage, useI18n } from '../i18n'
import { SEVERITY_COLOR, cx, truncate } from '../lib/format'

interface Props {
  card: ScoreCard
  dimensions: Dimension[]
  onLocate: (stepIndex: number) => void
}

type SeverityFilter = 'all' | Severity

export function FindingsPanel({ card, dimensions, onLocate }: Props) {
  const { locale, t } = useI18n()
  const [severity, setSeverity] = useState<SeverityFilter>('all')
  const [dimension, setDimension] = useState<string>('all')

  const dimensionLabel = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of dimensions) {
      const key = `dimension.${item.id}`
      map.set(item.id, hasMessage(locale, key) ? t(key) : item.label)
    }
    return map
  }, [dimensions, locale, t])

  const visible = card.findings.filter(
    (finding) =>
      (severity === 'all' || finding.severity === severity) &&
      (dimension === 'all' || finding.dimension === dimension),
  )

  return (
    <section className="panel findings-panel glass">
      <header className="panel-head">
        <span className="panel-title">{t('findings.title')}</span>
        <span className="panel-sub">
          {visible.length} / {card.findings.length}
        </span>
      </header>

      <div className="filter-row">
        <div className="chip-group">
          {(['all', 'error', 'warn', 'info'] as SeverityFilter[]).map((item) => (
            <button
              type="button"
              key={item}
              className={cx('filter-chip', severity === item && 'active')}
              onClick={() => setSeverity(item)}
              aria-pressed={severity === item}
              style={
                item === 'all' ? undefined : { color: severity === item ? SEVERITY_COLOR[item] : undefined }
              }
            >
              {item === 'all' ? t('common.all') : t(`severity.${item}`)}
              {item !== 'all' && <b>{card.findings.filter((finding) => finding.severity === item).length}</b>}
            </button>
          ))}
        </div>
        <select
          value={dimension}
          onChange={(event) => setDimension(event.target.value)}
          aria-label={t('findings.filterDimension')}
        >
          <option value="all">{t('findings.allDimensions')}</option>
          {dimensions.map((item) => (
            <option key={item.id} value={item.id}>
              {dimensionLabel.get(item.id) ?? item.label}
            </option>
          ))}
        </select>
      </div>

      <div className="finding-scroll">
        {visible.length === 0 ? (
          <div className="empty-inline">
            <span>{t('findings.empty')}</span>
            <em>{t('findings.emptyHint')}</em>
          </div>
        ) : (
          visible.map((finding) => (
            <button
              type="button"
              className={cx('finding', finding.stepIndex !== undefined && 'clickable')}
              key={finding.id}
              onClick={() => {
                if (finding.stepIndex !== undefined) onLocate(finding.stepIndex)
              }}
            >
              <i className="finding-dot" style={{ background: SEVERITY_COLOR[finding.severity] }} />
              <span className="finding-body">
                <span className="finding-head">
                  <b>{finding.ruleTitle}</b>
                  <em>{dimensionLabel.get(finding.dimension) ?? finding.dimension}</em>
                  {finding.manual && <span className="manual-tag">{t('findings.manual')}</span>}
                </span>
                <span className="finding-msg">{finding.message}</span>
                {finding.evidence && <span className="finding-ev">{truncate(finding.evidence, 80)}</span>}
              </span>
              {finding.stepIndex !== undefined && (
                <span className="finding-step">#{finding.stepIndex + 1}</span>
              )}
            </button>
          ))
        )}
      </div>

      {card.ruleIssues.length > 0 && (
        <footer className="rule-issues">
          <span>{t('findings.ruleIssues')}</span>
          <ul>
            {card.ruleIssues.map((issue, index) => (
              <li key={`${issue.ruleId}-${index}`}>
                <b>{issue.ruleId}</b> {issue.message}
              </li>
            ))}
          </ul>
        </footer>
      )}
    </section>
  )
}
