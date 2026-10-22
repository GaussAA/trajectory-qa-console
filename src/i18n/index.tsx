/** UI 文案的单一入口。
 *
 *  设计取舍：
 *  1. 中文是源语言，键集合即类型；英文缺键会在编译期失败，不靠运行时兜底。
 *  2. 键是扁平的 `域.语义`，插值用 `{name}`，两语言的占位符由测试强制一致。
 *  3. 规则包里的标题与提示属「数据」，不在这里翻译——换语言需另导规则包。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
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

/** Priority: explicit choice > Chinese system locale > English. */
export function detectLocale(stored?: string | null, navigatorLanguage?: string): Locale {
  if (isLocale(stored)) return stored
  if (navigatorLanguage) {
    return navigatorLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
  }
  return 'zh-CN'
}

function readStoredLocale(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(LOCALE_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStoredLocale(locale: Locale): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // private mode / file:// — the switch still works for this session
  }
}

export interface I18nContextValue {
  locale: Locale
  t: Translate
  setLocale: (next: Locale) => void
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(
    () =>
      initialLocale ??
      detectLocale(readStoredLocale(), typeof navigator === 'undefined' ? undefined : navigator.language),
  )

  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = locale
  }, [locale])

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    writeStoredLocale(next)
  }, [])

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, params) => translate(locale, key, params),
    }),
    [locale, setLocale],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext)
  if (!context) throw new Error('useI18n must be used inside I18nProvider')
  return context
}

export function useT(): Translate {
  return useI18n().t
}
