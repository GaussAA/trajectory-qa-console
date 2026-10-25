import { useCallback, useEffect, useState } from 'react'
import type { RulePack } from '../../core/model'

/** 草稿相对当前生效的包有没有改动。按内容比，不按文本：只是缩进变了不算改动；
 *  解析不了（改到一半的 JSON）一定算改动。 */
function isDirty(draft: string, pack: RulePack): boolean {
  try {
    return JSON.stringify(JSON.parse(draft)) !== JSON.stringify(pack)
  } catch {
    return true
  }
}

interface Options {
  open: boolean
  draft: string
  pack: RulePack
  onClose: () => void
}

/** 「可能是手滑」的关闭路径（点遮罩、Esc、右上角 ✕）：草稿有改动就先问一句。
 *  这些路径关掉的不只是抽屉——下次打开，草稿会被当前规则包覆盖，改了一半的 JSON 就没了。
 *  页脚的「取消」是明确的放弃，不走这里。 */
export function useDrawerClose({ open, draft, pack, onClose }: Options) {
  /** 正在问「放弃未保存的修改吗」。 */
  const [confirmClose, setConfirmClose] = useState(false)

  useEffect(() => {
    if (open) setConfirmClose(false)
  }, [open, pack])

  const requestClose = useCallback(() => {
    if (isDirty(draft, pack)) setConfirmClose(true)
    else onClose()
  }, [draft, pack, onClose])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      // 里面的控件已经处理过这次 Esc（比如取消重命名）：不要再把抽屉也关了。
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // 已经在问了，再按 Esc 是「算了，不关了」，而不是「确认丢弃」：
      // 否则连按两下 Esc 就等于没有确认。
      if (confirmClose) setConfirmClose(false)
      else requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, confirmClose, requestClose])

  return { confirmClose, dismissConfirm: () => setConfirmClose(false), requestClose }
}
