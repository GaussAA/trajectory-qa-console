// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { I18nProvider, LOCALE_STORAGE_KEY, useI18n } from './index'

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.documentElement.lang = ''
})

function Probe() {
  const { locale, t, setLocale } = useI18n()
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="label">{t('kpi.steps')}</span>
      <button type="button" onClick={() => setLocale('en')}>
        switch
      </button>
    </div>
  )
}

describe('I18nProvider', () => {
  it('renders the active dictionary and syncs <html lang>', async () => {
    const user = userEvent.setup()
    render(
      <I18nProvider initialLocale="zh-CN">
        <Probe />
      </I18nProvider>,
    )

    expect(screen.getByTestId('label').textContent).toBe('步骤')
    expect(document.documentElement.lang).toBe('zh-CN')

    await user.click(screen.getByRole('button', { name: 'switch' }))

    expect(screen.getByTestId('locale').textContent).toBe('en')
    expect(screen.getByTestId('label').textContent).toBe('Steps')
    expect(document.documentElement.lang).toBe('en')
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en')
  })

  it('refuses to be used outside the provider', () => {
    const quiet = console.error
    console.error = () => undefined
    try {
      expect(() => render(<Probe />)).toThrowError(/I18nProvider/)
    } finally {
      console.error = quiet
    }
  })
})
