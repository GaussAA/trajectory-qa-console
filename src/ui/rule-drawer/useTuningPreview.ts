import { useDeferredValue, useMemo } from 'react'
import type { RulePack } from '../../core/model'
import { validatePack } from '../../core/rules/contract'
import { buildTuningReport, type TuningSession } from '../../core/rules/tuning'

/** 试跑跟着草稿走，但用 deferred 值：大轨迹下敲字不会被重算卡住。
 *  草稿不是合法规则包时 `previewPack` 与 `tuning` 都是 null。 */
export function useTuningPreview(draft: string, sessions: TuningSession[]) {
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

  return { previewPack, tuning }
}

export type TuningPreview = ReturnType<typeof useTuningPreview>
