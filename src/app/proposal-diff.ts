/** 把提案的 edits 摊成人能读的「改前 → 改后」。
 *
 *  为什么界面上要这一步：`proposal.edits` 只说「改成什么」，不说「原来是什么」。
 *  一键应用一个自己没看清的改动，风险与盲改没区别——差异必须先看得见。
 */

import type { RuleEdit } from '../core/agent/types'
import type { RulePack } from '../core/model'

export type EditField = 'scoreImpact' | 'enabled' | 'severity' | 'expr'

export interface EditDiff {
  ruleId: string
  field: EditField
  before: string
  after: string
}

/** 固定顺序输出：同一份提案每次渲染的顺序必须一样，否则读起来像在跳。 */
const FIELDS: EditField[] = ['severity', 'scoreImpact', 'enabled', 'expr']

export function diffEdits(pack: RulePack, edits: RuleEdit[]): EditDiff[] {
  const diffs: EditDiff[] = []
  for (const edit of edits) {
    const rule = pack.rules.find((item) => item.id === edit.ruleId)
    // 找不到规则就不展示：那是坏提案，服务端已经拦过一次。
    if (!rule) continue
    for (const field of FIELDS) {
      const next = edit[field]
      if (next === undefined) continue
      const before = rule[field]
      if (before === next) continue
      diffs.push({ ruleId: edit.ruleId, field, before: String(before), after: String(next) })
    }
  }
  return diffs
}
