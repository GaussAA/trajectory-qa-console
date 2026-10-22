import { useEffect, useRef, useState } from 'react'
import type { ScoreCard } from '../core/analysis'
import { EXPR_FUNCTIONS } from '../core/expr'
import type { RuleIssue, RulePack } from '../core/model'
import { fieldsForScope, formatPackErrors, validatePack } from '../core/rules/contract'
import { useI18n } from '../i18n'
import { downloadFile, nowStamp } from '../lib/format'
import { Icon } from './Icons'
import { useFocusTrap } from './useFocusTrap'

interface Props {
  open: boolean
  pack: RulePack
  card: ScoreCard | null
  ruleIssues: RuleIssue[]
  onClose: () => void
  onApply: (pack: RulePack) => void
}

export function RuleDrawer({ open, pack, card, ruleIssues, onClose, onApply }: Props) {
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

  const uniqueIssues = new Map<string, string>()
  for (const issue of ruleIssues) uniqueIssues.set(`${issue.ruleId}:${issue.message}`, issue.message)

  const hits = new Map<string, number>()
  for (const finding of card?.findings ?? []) {
    if (finding.ruleId === 'manual') continue
    hits.set(finding.ruleId, (hits.get(finding.ruleId) ?? 0) + 1)
  }

  const stepFields = fieldsForScope('step')
  const trajectoryFields = fieldsForScope('trajectory')

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

          <details className="drawer-help">
            <summary>{t('rules.hits')}</summary>
            <div className="hit-list">
              {pack.rules.map((rule) => {
                const count = hits.get(rule.id) ?? 0
                return (
                  <div key={rule.id} className={count > 0 ? 'hit-row hit' : 'hit-row'}>
                    <span className="mono">{rule.id}</span>
                    <span className="hit-meta">
                      {t(`severity.${rule.severity}`)} · {t('rules.weight', { value: rule.scoreImpact })}
                    </span>
                    <span className="hit-count">{count}</span>
                  </div>
                )
              })}
            </div>
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
