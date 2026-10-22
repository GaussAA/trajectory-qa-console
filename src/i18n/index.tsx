/** React 侧入口：Provider 与 hooks。
 *
 *  纯逻辑（字典、插值、探测、时间格式化）在 `./core`，报告层直接用它，
 *  这样非组件代码无需依赖 React。这里只做转发与状态。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { detectLocale, isLocale, LOCALE_STORAGE_KEY, translate, type Locale, type Translate } from './core'

export {
  LOCALES,
  LOCALE_STORAGE_KEY,
  detectLocale,
  formatDateTime,
  getDictionary,
  hasMessage,
  interpolate,
  isLocale,
  labelFor,
  translate,
} from './core'
export type { Locale, MessageKey, Translate, TranslateParams } from './core'

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
    if (!isLocale(next)) return
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
