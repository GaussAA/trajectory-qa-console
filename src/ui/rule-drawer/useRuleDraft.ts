import { useEffect, useState } from 'react'
import type { RulePack } from '../../core/model'
import { formatPackErrors, validatePack } from '../../core/rules/contract'
import { replaceLiteral } from '../../core/rules/tuning'
import { useI18n } from '../../i18n'

/** 规则包草稿：抽屉里所有编辑入口（原始 JSON、调参、载入内置包、导入文件）都只写这一份文本，
 *  「校验并应用」是它变成生效规则包的唯一出口。 */
export function useRuleDraft(open: boolean, pack: RulePack, onApply: (pack: RulePack) => void) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (!open) return
    setDraft(JSON.stringify(pack, null, 2))
    setErrors([])
    setStatus('')
  }, [open, pack])

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

  /** 载入内置包：和导入文件一样只写草稿，「校验并应用」仍是唯一生效入口。 */
  const loadBuiltin = (builtin: RulePack, name: string) => {
    setDraft(JSON.stringify(builtin, null, 2))
    setErrors([])
    setStatus(t('rules.builtinLoaded', { name }))
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

  return { draft, setDraft, errors, status, setStatus, apply, reset, loadBuiltin, importFile, tuneThreshold }
}
