import { useState } from 'react'
import type { PackVariant, RulePack } from '../../core/model'
import { validatePack } from '../../core/rules/contract'
import { useI18n } from '../../i18n'

interface Options {
  draft: string
  variants: PackVariant[]
  setStatus: (status: string) => void
  onSave?: (name: string, pack: RulePack) => unknown
  onRename?: (id: string, name: string) => void
}

/** 变体的存档与重命名交互状态。变体本身归工作区，这里只管输入框里的临时状态。 */
export function useVariantEditor({ draft, variants, setStatus, onSave, onRename }: Options) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const changeName = (next: string) => {
    setName(next)
    setError('')
  }

  /** 存变体：存的是**当前草稿**（含未应用的调参）——这是变体的全部意义。 */
  const save = () => {
    const trimmed = name.trim()
    if (trimmed === '') {
      setError(t('variants.nameRequired'))
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(draft)
    } catch {
      setError(t('rules.tuneJsonInvalid'))
      return
    }
    const result = validatePack(parsed)
    if (!result.ok) {
      setError(t('variants.invalidDraft'))
      return
    }
    setError('')
    onSave?.(trimmed, result.pack)
    setName('')
    setStatus(t('variants.saved', { name: trimmed }))
  }

  const startRename = (variant: PackVariant) => {
    setRenamingId(variant.id)
    setRenameDraft(variant.name)
  }

  const cancelRename = () => setRenamingId(null)

  /** 空名视为取消：reducer 对空名与原名都是 no-op，这里少发一次事件。 */
  const commitRename = () => {
    const currentName = variants.find((variant) => variant.id === renamingId)?.name ?? ''
    if (renamingId && renameDraft.trim() !== '' && renameDraft.trim() !== currentName) {
      onRename?.(renamingId, renameDraft)
    }
    setRenamingId(null)
  }

  return {
    name,
    changeName,
    error,
    save,
    renamingId,
    renameDraft,
    setRenameDraft,
    startRename,
    cancelRename,
    commitRename,
  }
}

export type VariantEditor = ReturnType<typeof useVariantEditor>
