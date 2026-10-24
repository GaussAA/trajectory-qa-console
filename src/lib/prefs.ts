/** 界面偏好：纯 UI 状态（面板折叠等），不进工作区、不参与重算。
 *
 *  与语言切换同一路子：存在 localStorage，读不到就退回默认值。
 *  刻意不进 reducer——折叠左栏不该让评分重算一次。
 */

const KEYS = {
  leftCollapsed: 'tqa.left-collapsed',
} as const

function readFlag(key: string): boolean | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const value = localStorage.getItem(key)
    return value === null ? null : value === '1'
  } catch {
    // private mode / file:// —— 用默认值即可
    return null
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // 存不下就算了，本次会话内仍然有效
  }
}

/** 左栏是否折叠成图标条。默认展开——折叠是用户的选择，不是系统的强制。 */
export function readLeftCollapsed(): boolean {
  return readFlag(KEYS.leftCollapsed) ?? false
}

export function writeLeftCollapsed(value: boolean): void {
  writeFlag(KEYS.leftCollapsed, value)
}
