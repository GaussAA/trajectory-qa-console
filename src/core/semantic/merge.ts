/** 把模型判定并进评分口径。
 *
 *  规则保持一致：发现的扣分走 severity 映射，和人工标注同一量级——
 *  模型的结论不该比人写的标注更「重」，也不该更轻。
 */

import type { Finding, Severity } from '../model'
import { hasMessage, translate, type Locale, type MessageKey } from '../../i18n/core'
import type { SemanticFinding } from './types'

/** 与人工标注同量级：error 8 / warn 5 / info 2 → LLM 略高，因为它通常带证据。 */
export const SEMANTIC_IMPACT: Record<Severity, number> = { error: 10, warn: 6, info: 3 }

export function ruleIdFor(category: SemanticFinding['category']): string {
  return `semantic.llm.${category}`
}

export function categoryLabel(locale: Locale, category: SemanticFinding['category']): string {
  const key = `semantic.category.${category}`
  return hasMessage(locale, key) ? translate(locale, key as MessageKey) : category
}

export function toFindings(items: SemanticFinding[], locale: Locale, trajectoryId: string): Finding[] {
  return items.map((item, index) => ({
    id: `${trajectoryId}:semantic:${index}`,
    ruleId: ruleIdFor(item.category),
    ruleTitle: categoryLabel(locale, item.category),
    dimension: 'semantic',
    severity: item.severity,
    // 模型原话（reason）不翻译、不改；我们自己的提示单独拼在后面，读者分得清谁说的。
    message: item.unverified
      ? `${item.reason} ${translate(locale, 'semantic.unverifiedNote')}`
      : item.reason,
    stepIndex: item.step !== undefined ? item.step - 1 : undefined,
    evidence: item.quote,
    impact: SEMANTIC_IMPACT[item.severity],
  }))
}
