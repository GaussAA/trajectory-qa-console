import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { EXPR_FUNCTIONS } from '../core/expr'
import type { PackVariant, RuleIssue, RulePack } from '../core/model'
import { fieldsForScope, formatPackErrors, validatePack } from '../core/rules/contract'
import { buildTuningReport, numericLiterals, replaceLiteral, type TuningSession } from '../core/rules/tuning'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { comparePacks, type PackOption } from '../core/pack-compare'
import { buildPackCompareMarkdown } from '../lib/pack-compare-report'
import { formatDateTime } from '../i18n/core'
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
  /** 已保存的变体与当前生效者；抽屉负责展示，状态归工作区。 */
  variants?: PackVariant[]
  activeVariantId?: string | null
  onClose: () => void
  onApply: (pack: RulePack) => void
  /** 存变体：包由抽屉给定（含未应用的调参草稿）。返回 null 表示被拒（空名/超限）。 */
  onSaveVariant?: (name: string, pack: RulePack) => unknown
  onApplyVariant?: (id: string) => void
  onRenameVariant?: (id: string, name: string) => void
  onRemoveVariant?: (id: string) => void
  onExportVariants?: () => void
  onImportVariants?: (parsed: unknown) => void
}

export function RuleDrawer({
  open,
  pack,
  sessions,
  ruleIssues,
  variants = [],
  activeVariantId = null,
  onClose,
  onApply,
  onSaveVariant,
  onApplyVariant,
  onRenameVariant,
  onRemoveVariant,
  onExportVariants,
  onImportVariants,
}: Props) {
  const { locale, t } = useI18n()
  const [draft, setDraft] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [variantName, setVariantName] = useState('')
  const [variantError, setVariantError] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const variantFileRef = useRef<HTMLInputElement>(null)
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
      // 里面的控件已经处理过这次 Esc（比如取消重命名）：不要再把抽屉也关了。
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
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

  // 口径对比：当前包 / 内置包 / 各变体，两两对跑同一批轨迹。
  const packOptions = useMemo<PackOption[]>(
    () => [
      { id: 'current', name: t('packcmp.current'), pack },
      { id: 'builtin', name: t('packcmp.builtin'), pack: DEFAULT_PACK },
      ...variants.map((variant) => ({ id: variant.id, name: variant.name, pack: variant.pack })),
    ],
    [t, pack, variants],
  )
  const [baseId, setBaseId] = useState('current')
  const [targetPick, setTargetPick] = useState<string | null>(null)
  // 未选对照时挑第一个不等于基准的选项：打开就能看到差异，而不是「自己比自己」。
  const targetId = targetPick ?? packOptions.find((option) => option.id !== baseId)?.id ?? baseId
  const comparison = useMemo(() => {
    const resolve = (id: string): PackOption =>
      packOptions.find((option) => option.id === id) ?? (packOptions[0] as PackOption)
    return comparePacks(sessions, resolve(baseId).pack, resolve(targetId).pack)
  }, [sessions, baseId, targetId, packOptions])
  const resolveOption = (id: string): PackOption =>
    packOptions.find((option) => option.id === id) ?? (packOptions[0] as PackOption)
  const resolveName = (id: string) => resolveOption(id).name
  const packFor = (id: string) => resolveOption(id).pack

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

  /** 存变体：存的是**当前草稿**（含未应用的调参）——这是变体的全部意义。 */
  const saveVariant = () => {
    const name = variantName.trim()
    if (name === '') {
      setVariantError(t('variants.nameRequired'))
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(draft)
    } catch {
      setVariantError(t('rules.tuneJsonInvalid'))
      return
    }
    const result = validatePack(parsed)
    if (!result.ok) {
      setVariantError(t('variants.invalidDraft'))
      return
    }
    setVariantError('')
    onSaveVariant?.(name, result.pack)
    setVariantName('')
    setStatus(t('variants.saved', { name }))
  }

  const startRename = (variant: PackVariant) => {
    setRenamingId(variant.id)
    setRenameDraft(variant.name)
  }
  /** 空名视为取消：reducer 对空名与原名都是 no-op，这里少发一次事件。 */
  const commitRename = () => {
    if (renamingId && renameDraft.trim() !== '' && renameDraft.trim() !== currentNameOf(renamingId)) {
      onRenameVariant?.(renamingId, renameDraft)
    }
    setRenamingId(null)
  }
  const currentNameOf = (id: string) => variants.find((variant) => variant.id === id)?.name ?? ''

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
        className="drawer rules-drawer glass"
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

          <section className="variant-section">
            <div className="variant-head">
              <h4>{t('variants.title')}</h4>
              <span className="variant-tools">
                <input
                  ref={variantFileRef}
                  type="file"
                  accept=".json"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) {
                      void file.text().then((text) => {
                        try {
                          onImportVariants?.(JSON.parse(text))
                        } catch {
                          onImportVariants?.(null)
                        }
                      })
                    }
                    event.target.value = ''
                  }}
                />
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={variants.length === 0}
                  onClick={() => onExportVariants?.()}
                >
                  {t('variants.exportAll')}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => variantFileRef.current?.click()}
                >
                  {t('variants.import')}
                </button>
              </span>
            </div>
            <div className="variant-save-row">
              <input
                value={variantName}
                onChange={(event) => {
                  setVariantName(event.target.value)
                  setVariantError('')
                }}
                placeholder={t('variants.namePlaceholder')}
                aria-label={t('variants.save')}
                maxLength={40}
              />
              <button type="button" className="btn ghost sm" onClick={saveVariant}>
                <Icon name="edit" size={12} />
                {t('variants.save')}
              </button>
            </div>
            {variantError && <p className="hint warn-text">{variantError}</p>}
            {variants.length === 0 ? (
              <p className="hint">{t('variants.empty')}</p>
            ) : (
              <ul className="variant-list">
                {variants.map((variant) => {
                  const active = variant.id === activeVariantId
                  return (
                    <li key={variant.id} className={active ? 'variant-row active' : 'variant-row'}>
                      <span className="variant-name">
                        {renamingId === variant.id ? (
                          <input
                            autoFocus
                            value={renameDraft}
                            aria-label={t('variants.rename')}
                            maxLength={40}
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') commitRename()
                              if (event.key === 'Escape') {
                                // 只取消重命名：抽屉里可能还有没存的 JSON 草稿，别让这一下 Esc 把整个抽屉带走。
                                event.preventDefault()
                                setRenamingId(null)
                              }
                            }}
                            onBlur={commitRename}
                          />
                        ) : (
                          <>
                            <span
                              className="variant-name-text"
                              title={`${variant.name} · ${t('variants.renameHint')}`}
                              onDoubleClick={() => startRename(variant)}
                            >
                              {variant.name}
                            </span>
                            {active && <em>{t('variants.active')}</em>}
                            <button
                              type="button"
                              className="variant-edit"
                              aria-label={`${t('variants.rename')} ${variant.name}`}
                              title={t('variants.rename')}
                              onClick={() => startRename(variant)}
                            >
                              <Icon name="edit" size={11} />
                            </button>
                          </>
                        )}
                      </span>
                      <span className="variant-meta">
                        {t('variants.ruleCount', { count: variant.pack.rules.length })} ·{' '}
                        {formatDateTime(locale, new Date(variant.savedAt))}
                      </span>
                      <span className="variant-actions">
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() => onApplyVariant?.(variant.id)}
                          disabled={active}
                        >
                          {t('variants.apply')}
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm danger"
                          aria-label={`${t('variants.delete')} ${variant.name}`}
                          onClick={() => onRemoveVariant?.(variant.id)}
                        >
                          {t('variants.delete')}
                        </button>
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

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
                          base: { name: resolveName(baseId), pack: packFor(baseId) },
                          target: { name: resolveName(targetId), pack: packFor(targetId) },
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
                    <select value={baseId} onChange={(event) => setBaseId(event.target.value)}>
                      {packOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>{t('packcmp.target')}</span>
                    <select value={targetId} onChange={(event) => setTargetPick(event.target.value)}>
                      {packOptions.map((option) => (
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
                        <span
                          className={row.delta === 0 ? 'num flat' : row.delta > 0 ? 'num up' : 'num down'}
                          role="cell"
                        >
                          {row.delta > 0 ? `+${row.delta}` : row.delta}
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
                      <span
                        className={
                          comparison.targetAverage - comparison.baseAverage === 0
                            ? 'num flat'
                            : comparison.targetAverage > comparison.baseAverage
                              ? 'num up'
                              : 'num down'
                        }
                        role="cell"
                      >
                        {comparison.targetAverage - comparison.baseAverage > 0
                          ? `+${comparison.targetAverage - comparison.baseAverage}`
                          : comparison.targetAverage - comparison.baseAverage}
                      </span>
                    </div>
                  </div>
                )}
              </>
            )}
          </details>

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

          {/* 原始 JSON 是低频、危险的操作（手改错一个字段整包废掉），
              原先占抽屉上半屏，把真正常用的「试跑与调参」挤到折叠线以下。
              降级为默认收起的高级入口，顺序排在调参之后。 */}
          <details className="drawer-help">
            <summary>{t('rules.rawJson')}</summary>
            <textarea
              className="pack-editor"
              spellCheck={false}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
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
