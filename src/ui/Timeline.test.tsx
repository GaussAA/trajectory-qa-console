// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { I18nProvider } from '../i18n'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scoreTrajectory } from '../core/analysis'
import { DIMENSIONS } from '../core/rules/builtin-pack'
import type { Step, Trajectory } from '../core/model'
import { Timeline } from './Timeline'

afterEach(cleanup)

function renderTimeline(ui: ReactElement) {
  return render(<I18nProvider initialLocale="zh-CN">{ui}</I18nProvider>)
}

function syntheticTrajectory(count: number): Trajectory {
  const steps: Step[] = Array.from({ length: count }, (_, index) => ({
    index,
    role: index % 3 === 0 ? 'user' : index % 3 === 1 ? 'assistant' : 'tool',
    text: `第 ${index} 步的消息内容`,
    reasoning: '',
    toolCalls: [],
    tokens: { input: 0, output: 0, total: (index % 10) + 1, estimated: true },
    charCount: 12,
    raw: null,
    parseNotes: [],
  }))

  return {
    id: 'stress',
    label: 'stress.json',
    source: 'stress.json',
    steps,
    meta: { totalTokens: count, estimatedTokens: true },
    parseNotes: [],
  }
}

describe('Timeline virtualization', () => {
  it('renders a bounded number of rows for a 10,000-step trace', () => {
    const trajectory = syntheticTrajectory(10_000)
    const card = scoreTrajectory([], DIMENSIONS)
    const { container } = renderTimeline(
      <Timeline trajectory={trajectory} card={card} selectedStep={null} onSelectStep={() => undefined} />,
    )

    const rows = container.querySelectorAll('.step-row')
    expect(rows.length).toBeGreaterThan(10)
    expect(rows.length).toBeLessThan(60)
    expect(container.querySelector('.timeline-virtual')).toBeTruthy()
    expect(screen.getByText(/仅渲染可视区/)).toBeTruthy()
  })

  it('keeps the overview strip bounded as well', () => {
    const trajectory = syntheticTrajectory(5000)
    const card = scoreTrajectory([], DIMENSIONS)
    const { container } = renderTimeline(
      <Timeline trajectory={trajectory} card={card} selectedStep={null} onSelectStep={() => undefined} />,
    )

    expect(container.querySelectorAll('.map-tick').length).toBeLessThanOrEqual(180)
  })

  it('selects a step when its row is clicked', () => {
    const trajectory = syntheticTrajectory(1000)
    const card = scoreTrajectory([], DIMENSIONS)
    const onSelectStep = vi.fn()
    const { container } = renderTimeline(
      <Timeline trajectory={trajectory} card={card} selectedStep={null} onSelectStep={onSelectStep} />,
    )

    const first = container.querySelector('.step-row')
    expect(first).toBeTruthy()
    if (first) fireEvent.click(first)
    expect(onSelectStep).toHaveBeenCalledWith(0)
  })

  it('renders every row for a small trace', () => {
    const trajectory = syntheticTrajectory(12)
    const card = scoreTrajectory([], DIMENSIONS)
    const { container } = renderTimeline(
      <Timeline trajectory={trajectory} card={card} selectedStep={null} onSelectStep={() => undefined} />,
    )

    expect(container.querySelectorAll('.step-row')).toHaveLength(12)
    expect(container.querySelector('.timeline-virtual')).toBeNull()
  })
})
