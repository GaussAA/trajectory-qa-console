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

describe('Timeline legend', () => {
  it('labels the trace map colours so the rail is not a guessing game', () => {
    const trajectory = syntheticTrajectory(6)
    const card = scoreTrajectory([], DIMENSIONS)
    const { container } = renderTimeline(
      <Timeline trajectory={trajectory} card={card} selectedStep={null} onSelectStep={() => undefined} />,
    )

    // 色条原先没有任何图例，读者只能猜。角色名在步骤行里也有，
    // 所以只认图例容器内的顺序，避免「用户」撞到角色胶囊。
    const legend = container.querySelector('.trace-legend')
    expect(legend).not.toBeNull()
    const labels = [...(legend?.querySelectorAll('.trace-legend-item') ?? [])].map((node) =>
      node.textContent?.trim(),
    )
    expect(labels).toEqual(['系统', '用户', '助手', '工具', '含错误'])
  })
})

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

describe('Timeline scrolling respects reduced motion', () => {
  function withMotionPreference(reduce: boolean) {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: reduce && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia
    return () => {
      window.matchMedia = original
    }
  }

  function scrollBehaviourFor(reduce: boolean, compact: boolean): ScrollBehavior | undefined {
    const restore = withMotionPreference(reduce)
    const calls: (ScrollIntoViewOptions | ScrollToOptions | undefined)[] = []
    const originalInto = Element.prototype.scrollIntoView
    const originalTo = Element.prototype.scrollTo
    Element.prototype.scrollIntoView = function (arg?: boolean | ScrollIntoViewOptions) {
      calls.push(typeof arg === 'object' ? arg : undefined)
    }
    Element.prototype.scrollTo = function (arg?: unknown) {
      calls.push(typeof arg === 'object' ? (arg as ScrollToOptions) : undefined)
    } as typeof Element.prototype.scrollTo
    try {
      // 紧凑模式（>400 步）走 scrollTo，普通模式走 scrollIntoView
      const trajectory = syntheticTrajectory(compact ? 450 : 6)
      renderTimeline(
        <Timeline
          trajectory={trajectory}
          card={scoreTrajectory([], DIMENSIONS)}
          selectedStep={3}
          onSelectStep={() => undefined}
        />,
      )
      return (calls.at(-1) as { behavior?: ScrollBehavior } | undefined)?.behavior
    } finally {
      Element.prototype.scrollIntoView = originalInto
      Element.prototype.scrollTo = originalTo
      restore()
    }
  }

  it.each([
    ['ordinary rows', false],
    ['the compact virtual list', true],
  ])('scrolls smoothly in %s by default', (_name, compact) => {
    expect(scrollBehaviourFor(false, compact)).toBe('smooth')
  })

  it.each([
    ['ordinary rows', false],
    ['the compact virtual list', true],
  ])('jumps instead of animating in %s when the user asked for reduced motion', (_name, compact) => {
    // CSS 的 prefers-reduced-motion 管不到 JS 触发的 smooth 滚动，要自己查
    expect(scrollBehaviourFor(true, compact)).toBe('auto')
  })
})