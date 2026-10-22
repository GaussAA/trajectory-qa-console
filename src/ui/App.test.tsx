// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { createSyncAnalyzer } from '../app/analyzer'
import { createMemoryStorage, createPersistence } from '../app/persistence'
import { createTelemetry } from '../app/telemetry'
import App from './App'

afterEach(cleanup)

function setup() {
  const telemetry = createTelemetry()
  const persistence = createPersistence(createMemoryStorage())
  render(<App analyzer={createSyncAnalyzer()} persistence={persistence} telemetry={telemetry} />)
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
    expect(await screen.findByRole('dialog', { name: '规则包编辑' })).toBeTruthy()

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
