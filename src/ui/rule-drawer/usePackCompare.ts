import { useMemo, useState } from 'react'
import { comparePacks, type PackOption } from '../../core/compare/packs'
import type { PackVariant, RulePack } from '../../core/model'
import { DEFAULT_PACK } from '../../core/rules/builtin-pack'
import type { TuningSession } from '../../core/rules/tuning'
import { useI18n } from '../../i18n'

function pick(options: PackOption[], id: string): PackOption {
  return options.find((option) => option.id === id) ?? (options[0] as PackOption)
}

/** 口径对比：当前包 / 内置包 / 各变体，两两对跑同一批轨迹。 */
export function usePackCompare(sessions: TuningSession[], pack: RulePack, variants: PackVariant[]) {
  const { t } = useI18n()
  const options = useMemo<PackOption[]>(
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
  const targetId = targetPick ?? options.find((option) => option.id !== baseId)?.id ?? baseId
  const comparison = useMemo(
    () => comparePacks(sessions, pick(options, baseId).pack, pick(options, targetId).pack),
    [sessions, baseId, targetId, options],
  )

  return {
    options,
    baseId,
    targetId,
    setBaseId,
    setTargetId: setTargetPick,
    comparison,
    base: pick(options, baseId),
    target: pick(options, targetId),
  }
}

export type PackCompareState = ReturnType<typeof usePackCompare>
