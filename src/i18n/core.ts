/** 文案基座（纯逻辑，不依赖 React）。
 *
 *  界面用 `./index.tsx` 里的 Provider / hooks；报告、导出这类非组件代码直接
 *  用本模块的 `translate`，避免为了取一句文案把 React 拖进纯函数层。
 */

import { en } from './locales/en'
import { zhCN, type MessageKey } from './locales/zh-CN'

export type { MessageKey }

export type Locale = 'zh-CN' | 'en'

export type TranslateParams = Record<string, string | number>

export type Translate = (key: MessageKey, params?: TranslateParams) => string

export const LOCALES: { id: Locale; label: string }[] = [
  { id: 'zh-CN', label: '中文' },
  { id: 'en', label: 'EN' },
]

export const LOCALE_STORAGE_KEY = 'tqa.locale'

/** BCP 47 标签，交给 `Intl` / `toLocaleString` 用。 */
const INTL_TAG: Record<Locale, string> = { 'zh-CN': 'zh-CN', en: 'en-US' }

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = {
  'zh-CN': zhCN,
  en,
}

export function getDictionary(locale: Locale): Record<MessageKey, string> {
  return DICTIONARIES[locale]
}

export function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'en'
}

/** Replaces `{name}` placeholders; unknown placeholders stay visible on
 *  purpose — a silently blank label is harder to diagnose than `{count}`. */
export function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key]
    return value === undefined ? match : String(value)
  })
}

export function hasMessage(locale: Locale, key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(DICTIONARIES[locale], key)
}

export function translate(locale: Locale, key: MessageKey, params?: TranslateParams): string {
  const template = DICTIONARIES[locale][key]
  return interpolate(template ?? key, params)
}

/** 内建维度与等级是「代码里的概念」，可翻译；规则包里的维度属数据，回退原名。 */
export function labelFor(
  locale: Locale,
  prefix: 'dimension' | 'grade',
  id: string,
  fallback: string,
): string {
  const key = `${prefix}.${id}`
  return hasMessage(locale, key) ? translate(locale, key) : fallback
}

/** 报告里的时间戳：中文用 `2026/10/22 20:00:00`，英文用 `10/22/2026, 8:00 PM`。 */
export function formatDateTime(locale: Locale, date: Date): string {
  try {
    return date.toLocaleString(INTL_TAG[locale])
  } catch {
    return date.toISOString()
  }
}

/** Priority: explicit choice > Chinese system locale > English. */
export function detectLocale(stored?: string | null, navigatorLanguage?: string): Locale {
  if (isLocale(stored)) return stored
  if (navigatorLanguage) {
    return navigatorLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
  }
  return 'zh-CN'
}
