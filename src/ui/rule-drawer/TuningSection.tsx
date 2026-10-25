import type { RulePack } from '../../core/model'
import { numericLiterals } from '../../core/rules/tuning'
import { useI18n } from '../../i18n'
import type { TuningPreview } from './useTuningPreview'

interface Props {
  /** 当前生效的包：草稿不是合法规则包时，表格仍按它列出规则。 */
  pack: RulePack
  sessionCount: number
  preview: TuningPreview
  onTune: (ruleId: string, literalIndex: number, next: number) => void
}

/** 试跑与调参：每条规则在已载入轨迹上的真实命中数，数字阈值可直接改。 */
export function TuningSection({ pack, sessionCount, preview, onTune }: Props) {
  const { t } = useI18n()
  const { previewPack, tuning } = preview

  const rows = [...(previewPack?.rules ?? pack.rules)]
    .map((rule) => ({
      rule,
      stat: tuning?.rules.find((item) => item.ruleId === rule.id),
      literals: numericLiterals(rule.expr),
    }))
    .sort((a, b) => {
      const hits = (b.stat?.hits ?? 0) - (a.stat?.hits ?? 0)
      if (hits !== 0) return hits
      return a.rule.id.localeCompare(b.rule.id)
    })

  return (
    <details className="drawer-help" open>
      <summary>
        {t('rules.tune')}
        {tuning ? ` · ${t('rules.tuneAverage', { score: tuning.average })}` : ''}
      </summary>
      {!tuning ? (
        <p className="hint">{sessionCount === 0 ? t('rules.tuneNoData') : t('rules.tuneJsonInvalid')}</p>
      ) : (
        <>
          <p className="hint">{t('rules.tuneHint')}</p>
          {tuning.brokenRules.length > 0 && (
            <div className="drawer-errors">{t('rules.tuneBroken', { count: tuning.brokenRules.length })}</div>
          )}
          <div className="tune-table" role="table" aria-label={t('rules.tune')}>
            <div className="tune-row tune-head" role="row">
              <span role="columnheader">{t('rules.columnRule')}</span>
              <span role="columnheader">{t('rules.threshold')}</span>
              <span role="columnheader" className="tune-count">
                {t('rules.columnHits')}
              </span>
              <span role="columnheader" className="tune-gain">
                {t('rules.columnGain')}
              </span>
            </div>
            {rows.map(({ rule, stat, literals }) => {
              const hits = stat?.hits ?? 0
              return (
                <div
                  key={rule.id}
                  className={hits > 0 ? 'tune-row tune-hit' : 'tune-row'}
                  role="row"
                  data-rule={rule.id}
                >
                  <span className="tune-rule" role="cell" title={rule.expr}>
                    <b className="mono">{rule.id}</b>
                    <span className="tune-title">{rule.title}</span>
                  </span>
                  <span className="tune-thresholds" role="cell">
                    {literals.length === 0 && <span className="tune-none">—</span>}
                    {literals.map((literal) => (
                      <input
                        key={`${literal.index}-${literal.start}`}
                        className="tune-input"
                        type="number"
                        value={literal.value}
                        aria-label={`${rule.id} ${t('rules.threshold')} ${literal.index + 1}`}
                        onChange={(event) => {
                          const next = event.target.valueAsNumber
                          if (Number.isFinite(next)) onTune(rule.id, literal.index, next)
                        }}
                      />
                    ))}
                  </span>
                  <span className="tune-count" role="cell">
                    {hits}
                  </span>
                  <span className="tune-gain" role="cell">
                    {stat && stat.maxGain > 0 ? `+${stat.avgGain}` : '—'}
                  </span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </details>
  )
}
