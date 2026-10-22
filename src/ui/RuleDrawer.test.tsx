// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { analyze } from '../core/analysis'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { I18nProvider } from '../i18n'
import { RuleDrawer } from './RuleDrawer'

const TRACE = JSON.stringify([
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '查一下报销标准' },
  { role: 'assistant', content: '好的' },
  { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":' } }] },
])

function sessions() {
  const parsed = analyze({ source: TRACE, label: 'trace.json', pack: DEFAULT_PACK })
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value.map((session) => ({ id: session.id, trajectory: session.trajectory }))
}

function setup(props: Partial<Parameters<typeof RuleDrawer>[0]> = {}) {
  return render(
    <I18nProvider initialLocale="zh-CN">
      <RuleDrawer
        open
        pack={DEFAULT_PACK}
        sessions={sessions()}
        ruleIssues={[]}
        onClose={() => undefined}
        onApply={() => undefined}
        {...props}
      />
    </I18nProvider>,
  )
}

function row(container: HTMLElement, ruleId: string): HTMLElement {
  const element = container.querySelector(`[data-rule="${ruleId}"]`)
  if (!element) throw new Error(`row ${ruleId} not rendered`)
  return element as HTMLElement
}

function hitCount(container: HTMLElement, ruleId: string): string {
  const cell = row(container, ruleId).querySelector('.tune-count')
  return (cell?.textContent ?? '').trim()
}

afterEach(cleanup)

describe('RuleDrawer tuning panel', () => {
  it('shows real hits for the loaded sessions', async () => {
    const { container } = setup()
    await waitFor(() => expect(hitCount(container, 'structure-invalid-args')).toBe('1'))
    expect(screen.getByText(/试跑与调参/)).toBeTruthy()
    expect(screen.getByText(/试跑均分/)).toBeTruthy()
  })

  it('re-counts hits when a threshold is edited', async () => {
    const { container } = setup()
    // eff-long-trace 的表达式是 stepCount > 40，本轨迹只有 4 步。
    await waitFor(() => expect(hitCount(container, 'eff-long-trace')).toBe('0'))

    const input = within(row(container, 'eff-long-trace')).getByRole('spinbutton')
    fireEvent.change(input, { target: { value: '1' } })

    await waitFor(() => expect(hitCount(container, 'eff-long-trace')).toBe('1'))
    // 阈值回写到草稿 JSON，才能被「校验并应用」带走
    const editor = container.querySelector('.pack-editor') as HTMLTextAreaElement
    expect(editor.value).toContain('"stepCount > 1"')
  })

  it('renders the panel in English', async () => {
    render(
      <I18nProvider initialLocale="en">
        <RuleDrawer
          open
          pack={DEFAULT_PACK}
          sessions={sessions()}
          ruleIssues={[]}
          onClose={() => undefined}
          onApply={() => undefined}
        />
      </I18nProvider>,
    )
    expect(await screen.findByText(/Dry run & tuning/)).toBeTruthy()
    expect(screen.getByText('Rule')).toBeTruthy()
    expect(screen.getByText('If off')).toBeTruthy()
  })

  it('explains that there is nothing to dry-run without traces', () => {
    setup({ sessions: [] })
    expect(screen.getByText(/先载入轨迹/)).toBeTruthy()
  })
})
