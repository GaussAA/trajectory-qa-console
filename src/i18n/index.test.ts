import { describe, expect, it } from 'vitest'
import {
  detectLocale,
  getDictionary,
  interpolate,
  isLocale,
  translate,
  type Locale,
  type MessageKey,
} from './index'

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort()
}

describe('interpolate', () => {
  it('replaces named placeholders including repeats', () => {
    expect(interpolate('{a} + {a} = {b}', { a: 1, b: 2 })).toBe('1 + 1 = 2')
  })

  it('leaves unknown placeholders visible instead of blanking them', () => {
    expect(interpolate('第 {step} 步', {})).toBe('第 {step} 步')
  })

  it('returns the template untouched without params', () => {
    expect(interpolate('原样')).toBe('原样')
  })
})

describe('detectLocale', () => {
  it('prefers an explicit stored choice', () => {
    expect(detectLocale('en', 'zh-CN')).toBe('en')
    expect(detectLocale('zh-CN', 'en-US')).toBe('zh-CN')
  })

  it('ignores junk in storage', () => {
    expect(detectLocale('fr', 'zh-CN')).toBe('zh-CN')
    expect(detectLocale(null, 'zh-TW')).toBe('zh-CN')
  })

  it('falls back to English for non-Chinese systems and Chinese when unknown', () => {
    expect(detectLocale(null, 'en-GB')).toBe('en')
    expect(detectLocale(null, undefined)).toBe('zh-CN')
  })

  it('narrows unknown values with isLocale', () => {
    expect(isLocale('en')).toBe(true)
    expect(isLocale('EN')).toBe(false)
  })
})

describe('dictionaries', () => {
  const locales: Locale[] = ['zh-CN', 'en']

  it('cover exactly the same keys', () => {
    const [zh, english] = locales.map((locale) => Object.keys(getDictionary(locale)).sort())
    expect(english).toEqual(zh)
  })

  it('have no empty values', () => {
    for (const locale of locales) {
      for (const [key, value] of Object.entries(getDictionary(locale))) {
        expect(value.trim(), `${locale}:${key}`).not.toBe('')
      }
    }
  })

  it('keep placeholder sets identical across languages', () => {
    const zh = getDictionary('zh-CN')
    const english = getDictionary('en')
    for (const key of Object.keys(zh) as MessageKey[]) {
      expect(placeholders(english[key]), key).toEqual(placeholders(zh[key]))
    }
  })
})

describe('translate', () => {
  it('resolves a key with params', () => {
    expect(translate('zh-CN', 'kpi.steps')).toBe('步骤')
    expect(translate('en', 'issues.filesFailed', { count: 2 })).toBe('2 file(s) failed')
  })

  it('falls back to the key itself for unknown entries', () => {
    expect(translate('en', 'no.such.key' as MessageKey)).toBe('no.such.key')
  })
})
