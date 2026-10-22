import { useMemo, useState } from 'react'
import type { Dimension } from '../core/rules'
import { SEVERITY_LABEL } from '../core/rules'
import type { ScoreCard } from '../core/score'
import type { Severity } from '../core/types'
import { SEVERITY_COLOR, cx, truncate } from '../lib/format'

interface Props {
  card: ScoreCard
  dimensions: Dimension[]
  onLocate: (stepIndex: number) => void
}

type SeverityFilter = 'all' | Severity

export function FindingsPanel({ card, dimensions, onLocate }: Props) {
  const [severity, setSeverity] = useState<SeverityFilter>('all')
  const [dimension, setDimension] = useState<string>('all')

  const dimensionLabel = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of dimensions) map.set(item.id, item.label)
    return map
  }, [dimensions])

  const visible = card.findings.filter(
    (finding) =>
      (severity === 'all' || finding.severity === severity) &&
      (dimension === 'all' || finding.dimension === dimension),
  )

  return (
    <section className="panel findings-panel glass">
      <header className="panel-head">
        <span className="panel-title">问题清单</span>
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
              style={item === 'all' ? undefined : { color: severity === item ? SEVERITY_COLOR[item] : undefined }}
            >
              {item === 'all' ? '全部' : SEVERITY_LABEL[item]}
              {item !== 'all' && (
                <b>{card.findings.filter((finding) => finding.severity === item).length}</b>
              )}
            </button>
          ))}
        </div>
        <select value={dimension} onChange={(event) => setDimension(event.target.value)}>
          <option value="all">全部维度</option>
          {dimensions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </div>

      <div className="finding-scroll">
        {visible.length === 0 ? (
          <div className="empty-inline">
            <span>当前筛选下没有问题</span>
            <em>调整筛选，或该维度确实干净</em>
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
                  {finding.manual && <span className="manual-tag">人工</span>}
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
          <span>规则异常</span>
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
