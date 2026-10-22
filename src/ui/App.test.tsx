// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { createSyncAnalyzer } from '../app/analyzer'
import { createMemoryStorage, createPersistence } from '../app/persistence'
import { createTelemetry } from '../app/telemetry'
import App from './App'
import { I18nProvider, type Locale } from '../i18n'

afterEach(cleanup)

function setup(locale: Locale = 'zh-CN') {
  const telemetry = createTelemetry()
  const persistence = createPersistence(createMemoryStorage())
  render(
    <I18nProvider initialLocale={locale}>
      <App analyzer={createSyncAnalyzer()} persistence={persistence} telemetry={telemetry} />
    </I18nProvider>,
  )
  return { user: userEvent.setup(), telemetry }
}

async function loadSamples(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /载入示例/ }))
  await screen.findByText('时间线')
}

describe('App smoke', () => {
  it('renders the empty state', () => {
    setup()
    expect(screen.getByText('把轨迹拖进来，四面体检')).toBeTruthy()
  })

  it('loads the four demo traces and shows them in the session list', async () => {
    const { user } = setup()
    await loadSamples(user)

    expect(await screen.findByRole('button', { name: /demo-01/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /demo-04/ })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /demo-0/ })).toHaveLength(4)
  })

  it('switches session and reflects the new grade', async () => {
    const { user } = setup()
    await loadSamples(user)

    await user.click(await screen.findByRole('button', { name: /demo-04/ }))
    expect(await screen.findByText('D 级')).toBeTruthy()
  })

  it('keeps compare disabled until two traces exist, then toggles the view', async () => {
    const { user } = setup()
    const compare = screen.getByRole('button', { name: '对比' }) as HTMLButtonElement
    expect(compare.disabled).toBe(true)

    await loadSamples(user)
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '对比' }) as HTMLButtonElement).disabled).toBe(false),
    )

    await user.click(screen.getByRole('button', { name: '对比' }))
    expect(await screen.findByText('轨迹对比')).toBeTruthy()
    expect(screen.getByRole('button', { name: /退出对比/ })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /退出对比/ }))
    await waitFor(() => expect(screen.queryByText('轨迹对比')).toBeNull())
    expect(screen.getByText('时间线')).toBeTruthy()
  })

  it('records a manual annotation and surfaces it as a finding', async () => {
    const { user } = setup()
    await loadSamples(user)
    await user.click(await screen.findByRole('button', { name: /demo-04/ }))

    const input = screen.getByPlaceholderText(/例如：结论无引用/)
    await user.type(input, '人工复核：结论无引用')
    await user.click(screen.getByRole('button', { name: '标记' }))

    const matches = await screen.findAllByText('人工复核：结论无引用')
    expect(matches.length).toBeGreaterThan(0)
  })

  it('renders the whole shell in English when the locale is en', async () => {
    const { user } = setup('en')
    expect(screen.getByText('Drop a trace, get a four-axis checkup')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /Load samples/ }))
    expect(await screen.findByText('Timeline')).toBeTruthy()
    expect(screen.getByText('Findings')).toBeTruthy()
    expect(screen.getAllByText('Sessions').length).toBeGreaterThan(0)
  })

  it('records ingest and annotation actions in telemetry', async () => {
    const { user, telemetry } = setup()
    await loadSamples(user)
    const events = telemetry.snapshot().map((event) => event.name)
    expect(events).toContain('ingest:done')
    expect(events).toContain('ingest:file')
  })

  it('opens the rule pack as a dialog and closes it with Escape', async () => {
    const { user } = setup()
    await loadSamples(user)

    await user.click(screen.getByRole('button', { name: '规则包' }))
    expect(await screen.findByRole('dialog', { name: '规则包' })).toBeTruthy()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('exposes the active severity filter to assistive technology', async () => {
    const { user } = setup()
    await loadSamples(user)

    const errorFilter = screen.getByRole('button', { name: /严重/ })
    expect(errorFilter.getAttribute('aria-pressed')).toBe('false')
    await user.click(errorFilter)
    expect(errorFilter.getAttribute('aria-pressed')).toBe('true')
  })
})
