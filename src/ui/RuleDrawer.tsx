import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { EXPR_FUNCTIONS } from '../core/expr'
import type { RuleIssue, RulePack } from '../core/model'
import { fieldsForScope, formatPackErrors, validatePack } from '../core/rules/contract'
import { buildTuningReport, numericLiterals, replaceLiteral, type TuningSession } from '../core/rules/tuning'
import { useI18n } from '../i18n'
import { downloadFile, nowStamp } from '../lib/format'
import { Icon } from './Icons'
import { useFocusTrap } from './useFocusTrap'

interface Props {
  open: boolean
  pack: RulePack
  /** 已载入的轨迹：试跑要拿它们真跑一遍，而不是估算。 */
  sessions: TuningSession[]
  ruleIssues: RuleIssue[]
  onClose: () => void
  onApply: (pack: RulePack) => void
}

export function RuleDrawer({ open, pack, sessions, ruleIssues, onClose, onApply }: Props) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useFocusTrap(panelRef, open)

  useEffect(() => {
    if (!open) return
    setDraft(JSON.stringify(pack, null, 2))
    setErrors([])
    setStatus('')
  }, [open, pack])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // 试跑跟着草稿走，但用 deferred 值：大轨迹下敲字不会被重算卡住。
  const deferredDraft = useDeferredValue(draft)
  const previewPack = useMemo<RulePack | null>(() => {
    try {
      const result = validatePack(JSON.parse(deferredDraft))
      return result.ok ? result.pack : null
    } catch {
      return null
    }
  }, [deferredDraft])

  const tuning = useMemo(
    () => (previewPack && sessions.length > 0 ? buildTuningReport(sessions, previewPack) : null),
    [previewPack, sessions],
  )

  if (!open) return null

  const apply = () => {
    setStatus('')
    let parsed: unknown
    try {
      parsed = JSON.parse(draft)
    } catch (error) {
      setErrors([t('rules.jsonError', { message: error instanceof Error ? error.message : String(error) })])
      return
    }
    const result = validatePack(parsed)
    if (!result.ok) {
      setErrors(formatPackErrors(result.errors).slice(0, 12))
      return
    }
    setErrors([])
    onApply(result.pack)
    setStatus(
      t('rules.applied', { rules: result.pack.rules.length, dimensions: result.pack.dimensions.length }),
    )
  }

  const reset = () => {
    setDraft(JSON.stringify(pack, null, 2))
    setErrors([])
    setStatus('')
  }

  const importFile = async (file: File | undefined) => {
    if (!file) return
    const text = await file.text()
    setDraft(text)
    setErrors([])
    setStatus(t('rules.imported', { file: file.name }))
  }

  /** 改阈值：只替换那个字面量，替换后不合法就原地不动（输入框回弹即提示）。 */
  const tuneThreshold = (ruleId: string, literalIndex: number, next: number) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(draft)
    } catch {
      return
    }
    const rules = (parsed as { rules?: { id?: string; expr?: string }[] }).rules
    const rule = rules?.find((item) => item.id === ruleId)
    if (!rule || typeof rule.expr !== 'string') return

    const rewritten = replaceLiteral(rule.expr, literalIndex, next)
    if (rewritten === null) {
      setStatus(t('rules.thresholdRejected'))
      return
    }
    rule.expr = rewritten
    setStatus('')
    setDraft(JSON.stringify(parsed, null, 2))
  }

  const uniqueIssues = new Map<string, string>()
  for (const issue of ruleIssues) uniqueIssues.set(`${issue.ruleId}:${issue.message}`, issue.message)

  const stepFields = fieldsForScope('step')
  const trajectoryFields = fieldsForScope('trajectory')

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
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <div
        className="drawer glass"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('rules.title')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer-head">
          <div>
            <h3>{t('rules.title')}</h3>
            <p>{t('rules.description')}</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            title={t('rules.closeHint')}
            aria-label={t('common.close')}
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="drawer-body">
          <textarea
            className="pack-editor"
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />

          {errors.length > 0 && (
            <div className="drawer-errors">
              {errors.map((error, index) => (
                <div key={index}>{error}</div>
              ))}
            </div>
          )}
          {status && <div className="drawer-status">{status}</div>}

          {uniqueIssues.size > 0 && (
            <div className="drawer-issues">
              <span>{t('rules.currentIssues')}</span>
              <ul>
                {[...uniqueIssues.entries()].map(([key, message]) => (
                  <li key={key}>
                    <b>{key.split(':')[0]}</b> {message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <details className="drawer-help" open>
            <summary>
              {t('rules.tune')}
              {tuning ? ` · ${t('rules.tuneAverage', { score: tuning.average })}` : ''}
            </summary>
            {!tuning ? (
              <p className="hint">
                {sessions.length === 0 ? t('rules.tuneNoData') : t('rules.tuneJsonInvalid')}
              </p>
            ) : (
              <>
                <p className="hint">{t('rules.tuneHint')}</p>
                {tuning.brokenRules.length > 0 && (
                  <div className="drawer-errors">
                    {t('rules.tuneBroken', { count: tuning.brokenRules.length })}
                  </div>
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
                                if (Number.isFinite(next)) tuneThreshold(rule.id, literal.index, next)
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

          <details className="drawer-help">
            <summary>{t('rules.help')}</summary>
            <div className="field-groups">
              <div>
                <h5>{t('rules.stepScope', { count: stepFields.length })}</h5>
                <ul>
                  {stepFields.map((field) => (
                    <li key={field.name}>
                      <b>{field.name}</b>
                      <span>
                        {field.type} · {field.description}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h5>{t('rules.trajectoryScope', { count: trajectoryFields.length })}</h5>
                <ul>
                  {trajectoryFields.map((field) => (
                    <li key={field.name}>
                      <b>{field.name}</b>
                      <span>
                        {field.type} · {field.description}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h5>{t('rules.functions')}</h5>
                <ul>
                  {EXPR_FUNCTIONS.map((fn) => (
                    <li key={fn.name}>
                      <b>{fn.signature}</b>
                      <span>{fn.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="hint">{t('rules.templateHint')}</p>
          </details>
        </div>

        <footer className="drawer-foot">
          <input
            ref={fileRef}
            type="file"
            accept=".json,.jsonl"
            hidden
            onChange={(event) => {
              void importFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <button type="button" className="btn ghost sm" onClick={() => fileRef.current?.click()}>
            {t('common.import')}
          </button>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => downloadFile(`rule-pack-${nowStamp()}.json`, draft, 'application/json')}
          >
            {t('common.export')}
          </button>
          <button type="button" className="btn ghost sm" onClick={reset}>
            {t('common.reset')}
          </button>
          <span className="grow" />
          <button type="button" className="btn ghost sm" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary sm" onClick={apply}>
            {t('common.apply')}
          </button>
        </footer>
      </div>
    </div>
  )
}
