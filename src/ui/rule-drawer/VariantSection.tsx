import { useRef } from 'react'
import type { PackVariant } from '../../core/model'
import { formatDateTime } from '../../i18n/core'
import { useI18n } from '../../i18n'
import { Icon } from '../Icons'
import type { VariantEditor } from './useVariantEditor'

interface Props {
  variants: PackVariant[]
  activeVariantId: string | null
  editor: VariantEditor
  onApply?: (id: string) => void
  onRemove?: (id: string) => void
  onExport?: () => void
  onImport?: (parsed: unknown) => void
}

/** 已保存的规则包变体：存档、套用、重命名、删除、整包导出导入。 */
export function VariantSection({
  variants,
  activeVariantId,
  editor,
  onApply,
  onRemove,
  onExport,
  onImport,
}: Props) {
  const { locale, t } = useI18n()
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    <section className="variant-section">
      <div className="variant-head">
        <h4>{t('variants.title')}</h4>
        <span className="variant-tools">
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) {
                void file.text().then((text) => {
                  try {
                    onImport?.(JSON.parse(text))
                  } catch {
                    onImport?.(null)
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
            onClick={() => onExport?.()}
          >
            {t('variants.exportAll')}
          </button>
          <button type="button" className="btn ghost sm" onClick={() => fileRef.current?.click()}>
            {t('variants.import')}
          </button>
        </span>
      </div>
      <div className="variant-save-row">
        <input
          value={editor.name}
          onChange={(event) => editor.changeName(event.target.value)}
          placeholder={t('variants.namePlaceholder')}
          aria-label={t('variants.save')}
          maxLength={40}
        />
        <button type="button" className="btn ghost sm" onClick={editor.save}>
          <Icon name="edit" size={12} />
          {t('variants.save')}
        </button>
      </div>
      {editor.error && <p className="hint warn-text">{editor.error}</p>}
      {variants.length === 0 ? (
        <p className="hint">{t('variants.empty')}</p>
      ) : (
        <ul className="variant-list">
          {variants.map((variant) => {
            const active = variant.id === activeVariantId
            return (
              <li key={variant.id} className={active ? 'variant-row active' : 'variant-row'}>
                <span className="variant-name">
                  {editor.renamingId === variant.id ? (
                    <input
                      autoFocus
                      value={editor.renameDraft}
                      aria-label={t('variants.rename')}
                      maxLength={40}
                      onChange={(event) => editor.setRenameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') editor.commitRename()
                        if (event.key === 'Escape') {
                          // 只取消重命名：抽屉里可能还有没存的 JSON 草稿，别让这一下 Esc 把整个抽屉带走。
                          event.preventDefault()
                          editor.cancelRename()
                        }
                      }}
                      onBlur={editor.commitRename}
                    />
                  ) : (
                    <>
                      <span
                        className="variant-name-text"
                        title={`${variant.name} · ${t('variants.renameHint')}`}
                        onDoubleClick={() => editor.startRename(variant)}
                      >
                        {variant.name}
                      </span>
                      {active && <em>{t('variants.active')}</em>}
                      <button
                        type="button"
                        className="variant-edit"
                        aria-label={`${t('variants.rename')} ${variant.name}`}
                        title={t('variants.rename')}
                        onClick={() => editor.startRename(variant)}
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
                    onClick={() => onApply?.(variant.id)}
                    disabled={active}
                  >
                    {t('variants.apply')}
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm danger"
                    aria-label={`${t('variants.delete')} ${variant.name}`}
                    onClick={() => onRemove?.(variant.id)}
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
  )
}
