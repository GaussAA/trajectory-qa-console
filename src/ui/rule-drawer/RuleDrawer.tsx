import { useRef } from 'react'
import type { PackVariant, RuleIssue, RulePack } from '../../core/model'
import { DEFAULT_PACK } from '../../core/rules/builtin-pack'
import { BUILTIN_PACK_EN } from '../../core/rules/builtin-pack-en'
import type { TuningSession } from '../../core/rules/tuning'
import { useI18n } from '../../i18n'
import { downloadFile, nowStamp } from '../../lib/format'
import { Icon } from '../Icons'
import { useFocusTrap } from '../useFocusTrap'
import { FieldHelp } from './FieldHelp'
import { PackCompareSection } from './PackCompareSection'
import { TuningSection } from './TuningSection'
import { useDrawerClose } from './useDrawerClose'
import { usePackCompare } from './usePackCompare'
import { useRuleDraft } from './useRuleDraft'
import { useTuningPreview } from './useTuningPreview'
import { useVariantEditor } from './useVariantEditor'
import { VariantSection } from './VariantSection'

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

/** 规则抽屉。所有状态都在这一层的 hook 里，常驻不卸载：关掉再打开，
 *  口径对比的选择、变体输入框里写到一半的名字都还在。子组件只负责展示。 */
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
  const { t } = useI18n()
  const panelRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useFocusTrap(panelRef, open)

  const { draft, setDraft, errors, status, setStatus, apply, reset, loadBuiltin, importFile, tuneThreshold } =
    useRuleDraft(open, pack, onApply)
  const { confirmClose, dismissConfirm, requestClose } = useDrawerClose({ open, draft, pack, onClose })
  const variantEditor = useVariantEditor({
    draft,
    variants,
    setStatus,
    onSave: onSaveVariant,
    onRename: onRenameVariant,
  })
  const compare = usePackCompare(sessions, pack, variants)
  const preview = useTuningPreview(draft, sessions)

  if (!open) return null

  const uniqueIssues = new Map<string, string>()
  for (const issue of ruleIssues) uniqueIssues.set(`${issue.ruleId}:${issue.message}`, issue.message)

  return (
    <div className="drawer-backdrop" onMouseDown={requestClose}>
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
            onClick={requestClose}
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
              <h4>{t('rules.builtin')}</h4>
              <span className="variant-tools">
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => loadBuiltin(DEFAULT_PACK, t('rules.builtinZh'))}
                >
                  {t('rules.builtinZh')}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => loadBuiltin(BUILTIN_PACK_EN, t('rules.builtinEn'))}
                >
                  {t('rules.builtinEn')}
                </button>
              </span>
            </div>
          </section>

          <VariantSection
            variants={variants}
            activeVariantId={activeVariantId}
            editor={variantEditor}
            onApply={onApplyVariant}
            onRemove={onRemoveVariant}
            onExport={onExportVariants}
            onImport={onImportVariants}
          />

          <PackCompareSection sessions={sessions} compare={compare} />

          <TuningSection
            pack={pack}
            sessionCount={sessions.length}
            preview={preview}
            onTune={tuneThreshold}
          />

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

          <FieldHelp />
        </div>

        {confirmClose && (
          <div className="drawer-confirm" role="alertdialog" aria-label={t('rules.confirmClose')}>
            <span>{t('rules.confirmClose')}</span>
            <span className="grow" />
            <button type="button" className="btn ghost sm" autoFocus onClick={dismissConfirm}>
              {t('rules.keepEditing')}
            </button>
            <button type="button" className="btn ghost sm danger" onClick={onClose}>
              {t('rules.discardAndClose')}
            </button>
          </div>
        )}

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
