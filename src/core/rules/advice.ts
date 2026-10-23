/** 由 findings 推出「该怎么修」。
 *
 *  两条纪律：
 *  1. 只给**能落到具体动作**的规则写建议。没有映射就跳过——「请注意优化」这类
 *     话对读者毫无价值，还会稀释真有价值的那几条。
 *  2. 同一规则只出一次，按严重度与出现次数排序。读者要的是「先修哪个」。
 *
 *  文案走 i18n（`advice.<ruleId>`），因为建议是**工具对这条规则的看法**，
 *  而不是规则包里的数据——换规则包不该改变我们对「死循环怎么修」的判断。
 */

import type { Finding, Severity } from '../model'
import { hasMessage, translate, type Locale, type MessageKey } from '../../i18n/core'

export interface Advice {
  ruleId: string
  /** 命中次数，用来告诉读者「这条不是偶发」。 */
  count: number
  severity: Severity
  text: string
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 }

const ADVICE_PREFIX = 'advice.'

export function adviceKey(ruleId: string): string {
  return `${ADVICE_PREFIX}${ruleId}`
}

/** 有建议的规则才能出条目；没有就返回 null（宁缺勿滥）。 */
export function adviceFor(locale: Locale, ruleId: string): string | null {
  const key = adviceKey(ruleId)
  return hasMessage(locale, key) ? translate(locale, key as MessageKey) : null
}

export function buildAdvice(findings: Finding[], locale: Locale, limit = 6): Advice[] {
  const grouped = new Map<string, { count: number; severity: Severity }>()

  for (const finding of findings) {
    if (finding.manual === true) continue
    const entry = grouped.get(finding.ruleId)
    if (!entry) {
      grouped.set(finding.ruleId, { count: 1, severity: finding.severity })
      continue
    }
    entry.count += 1
    if (SEVERITY_RANK[finding.severity] < SEVERITY_RANK[entry.severity]) entry.severity = finding.severity
  }

  const advice: Advice[] = []
  for (const [ruleId, entry] of grouped) {
    const text = adviceFor(locale, ruleId)
    if (!text) continue
    advice.push({ ruleId, count: entry.count, severity: entry.severity, text })
  }

  advice.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (bySeverity !== 0) return bySeverity
    if (a.count !== b.count) return b.count - a.count
    return a.ruleId.localeCompare(b.ruleId)
  })

  return advice.slice(0, Math.max(0, limit))
}
