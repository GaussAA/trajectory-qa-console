import type { TuningSession } from '../../core/rules/tuning'
import { useI18n } from '../../i18n'
import { downloadFile, nowStamp } from '../../lib/format'
import { buildPackCompareMarkdown } from '../../lib/pack-compare-report'
import { Icon } from '../Icons'
import type { PackCompareState } from './usePackCompare'

interface Props {
  sessions: TuningSession[]
  compare: PackCompareState
}

function deltaClass(delta: number): string {
  return delta === 0 ? 'num flat' : delta > 0 ? 'num up' : 'num down'
}

function signed(delta: number): string | number {
  return delta > 0 ? `+${delta}` : delta
}

/** 口径对比：同一批轨迹分别用两份规则包跑一遍，逐会话看分数差。 */
export function PackCompareSection({ sessions, compare }: Props) {
  const { locale, t } = useI18n()
  const { comparison, options, baseId, targetId } = compare
  const averageDelta = comparison.targetAverage - comparison.baseAverage

  return (
    <details className="drawer-help">
      <summary>{t('packcmp.title')}</summary>
      {sessions.length === 0 ? (
        <p className="hint">{t('packcmp.needSessions')}</p>
      ) : (
        <>
          <div className="packcmp-export-row">
            <button
              type="button"
              className="btn ghost sm"
              onClick={() =>
                downloadFile(
                  `pack-compare-${nowStamp()}.md`,
                  buildPackCompareMarkdown({
                    sessions,
                    base: { name: compare.base.name, pack: compare.base.pack },
                    target: { name: compare.target.name, pack: compare.target.pack },
                    generatedAt: new Date(),
                    locale,
                  }),
                  'text/markdown',
                )
              }
            >
              <Icon name="download" size={12} />
              {t('packcmp.export')}
            </button>
          </div>
          <div className="packcmp-pickers">
            <label>
              <span>{t('packcmp.base')}</span>
              <select value={baseId} onChange={(event) => compare.setBaseId(event.target.value)}>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t('packcmp.target')}</span>
              <select value={targetId} onChange={(event) => compare.setTargetId(event.target.value)}>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {comparison.identical ? (
            <p className="hint">{t('packcmp.same')}</p>
          ) : (
            <div className="packcmp-table" role="table" aria-label={t('packcmp.title')}>
              <div className="packcmp-row packcmp-head" role="row">
                <span role="columnheader">{t('report.sessionHeader')}</span>
                <span role="columnheader" className="num">
                  {t('report.compare.baseColumn')}
                </span>
                <span role="columnheader" className="num">
                  {t('report.compare.targetColumn')}
                </span>
                <span role="columnheader" className="num">
                  {t('packcmp.delta')}
                </span>
              </div>
              {comparison.rows.map((row) => (
                <div key={row.sessionId} className="packcmp-row" role="row" title={row.label}>
                  <span role="cell">{row.label}</span>
                  <span className="num" role="cell">
                    {row.base}
                  </span>
                  <span className="num" role="cell">
                    {row.target}
                  </span>
                  <span className={deltaClass(row.delta)} role="cell">
                    {signed(row.delta)}
                  </span>
                </div>
              ))}
              <div className="packcmp-row packcmp-average" role="row">
                <span role="cell">{t('packcmp.average')}</span>
                <span className="num" role="cell">
                  {comparison.baseAverage}
                </span>
                <span className="num" role="cell">
                  {comparison.targetAverage}
                </span>
                <span className={deltaClass(averageDelta)} role="cell">
                  {signed(averageDelta)}
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </details>
  )
}
