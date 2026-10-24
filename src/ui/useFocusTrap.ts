import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** 当前开着的陷阱，后开的在后面。只有最后一个响应 Tab。
 *  抽屉、对比、诊断可能同时开着；每个都去抢焦点，就是几个陷阱互相把焦点拽来拽去。 */
const stack: HTMLElement[] = []

/** Keeps Tab inside a dialog and restores focus when it closes.
 *  jsdom reports no layout, so `offsetParent` filtering simply yields nothing
 *  there — the hook degrades to a no-op instead of throwing.
 *
 *  监听挂在 `document` 上而不是对话框节点上：节点上的监听只在焦点已经在框内时才收得到 Tab，
 *  点了遮罩、或脚本把焦点挪走之后，焦点落在框外，Tab 就在页面其余部分里走，陷阱形同虚设。 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return
    const node = ref.current
    if (!node) return

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusable = () =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null,
      )

    focusable()[0]?.focus()
    stack.push(node)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      if (stack[stack.length - 1] !== node) return
      const items = focusable()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return

      const current = document.activeElement
      // 焦点已经跑到框外：拉回来，而不是任它往页面后面走。
      if (!(current instanceof Node) || !node.contains(current)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
        return
      }
      if (event.shiftKey && current === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && current === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const index = stack.lastIndexOf(node)
      if (index >= 0) stack.splice(index, 1)
      previous?.focus?.()
    }
  }, [active, ref])
}
