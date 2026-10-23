// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyze } from '../core/analysis'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { scoreSession } from '../core/analysis'
import type { ScoreCard } from '../core/analysis'
import { I18nProvider } from '../i18n'
import { ComparePanel } from './ComparePanel'

const GOOD = JSON.stringify([
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '查报销标准' },
  { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":"x"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: '500 元' },
  { role: 'assistant', content: '上限 500 元。' },
])

const WORSE = JSON.stringify([
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '查报销标准' },
  { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":' } }] },
])

function fixtures() {
  const sessions = [GOOD, WORSE].map((source, index) => {
    const parsed = analyze({ source, label: `trace-${index + 1}.json`, pack: DEFAULT_PACK })
    if (!parsed.ok) throw new Error(parsed.error.message)
    return parsed.value[0]!
  })
  const cards = new Map<string, ScoreCard>(
    sessions.map((session) => [session.id, scoreSession(session, DEFAULT_PACK.dimensions)]),
  )
  return { sessions, cards }
}

function setup(locale: 'zh-CN' | 'en' = 'zh-CN') {
  const { sessions, cards } = fixtures()
  return render(
    <I18nProvider initialLocale={locale}>
      <ComparePanel
        sessions={sessions}
        cards={cards}
        initialBaseId={sessions[0]!.id}
        onClose={() => undefined}
      />
    </I18nProvider>,
  )
}

afterEach(cleanup)

describe('ComparePanel', () => {
  it('shows the score, dimension and step deltas', () => {
    setup()
    // 基准是 100 分的健康轨迹，对照是缺工具结果的轨迹：分数必然下降。
    expect(screen.getAllByText('100').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/^-\d+$/).length).toBeGreaterThan(0)
    expect(screen.getByText('维度得分')).toBeTruthy()
    expect(screen.getByText(/步骤: 5 → 3/)).toBeTruthy()
  })

  it('lists new and fixed findings', () => {
    setup()
    const chips = document.querySelectorAll('.compare-chip')
    expect(chips.length).toBe(3)
    // 对照轨迹缺配对结果，新增错误必然大于 0
    const added = screen.getAllByText(/新增 \d+/)[0]!
    expect(Number(added.textContent?.replace(/\D/g, ''))).toBeGreaterThan(0)
  })

  it('lists aligned step differences with status badges', () => {
    setup()
    const rows = document.querySelectorAll('.compare-step')
    expect(rows.length).toBeGreaterThan(0)
    const badges = [...document.querySelectorAll('.compare-step-badge')].map((node) => node.textContent)
    expect(badges.some((badge) => ['内容变化', '新增步', '删除步'].includes(badge ?? ''))).toBe(true)
  })

  it('flips the comparison direction through the pickers', () => {
    const { container } = setup()
    const selects = container.querySelectorAll<HTMLSelectElement>('.compare-select select')
    const base = selects[0] as HTMLSelectElement
    const target = selects[1] as HTMLSelectElement

    // 交换基准与对照：分数方向应当翻转（由降分变为涨分）
    fireEvent.change(base, { target: { value: base.options[1]!.value } })
    fireEvent.change(target, { target: { value: target.options[0]!.value } })

    const deltas = [...container.querySelectorAll('.compare-delta')].map((node) => node.textContent ?? '')
    expect(deltas.some((delta) => delta.startsWith('+'))).toBe(true)
  })

  it('exports the comparison as markdown', async () => {
    const bodies: string[] = []
    const originalUrl = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = ((blob: Blob) => {
      void blob.text().then((text) => bodies.push(text))
      return 'blob:mock'
    }) as typeof URL.createObjectURL
    URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    try {
      setup()
      fireEvent.click(screen.getByRole('button', { name: /导出对比/ }))
      await waitFor(() => expect(bodies).toHaveLength(1))
      expect(bodies[0]).toContain('# 轨迹对比报告')
      expect(bodies[0]).toContain('| 项目 | 基准 | 对照 | 变化 |')
      expect(click).toHaveBeenCalled()
    } finally {
      URL.createObjectURL = originalUrl
      // jsdom 没有 revokeObjectURL：若还原成 undefined，downloadFile 里 2s 后的
      // 定时器会抛未捕获异常，把整轮覆盖率判成失败。留一个 no-op 更安全。
      URL.revokeObjectURL = originalRevoke ?? (() => undefined)
      click.mockRestore()
    }
  })

  it('exports the comparison as a self-contained html', async () => {
    const bodies: string[] = []
    const originalUrl = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = ((blob: Blob) => {
      void blob.text().then((text) => bodies.push(text))
      return 'blob:html'
    }) as typeof URL.createObjectURL
    URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    try {
      setup()
      fireEvent.click(screen.getByRole('button', { name: 'HTML' }))
      await waitFor(() => expect(bodies).toHaveLength(1))
      expect(bodies[0]?.startsWith('<!doctype html>')).toBe(true)
      expect(bodies[0]).toContain('轨迹对比报告')
      expect(bodies[0]).not.toMatch(/<script/i)
      expect(click).toHaveBeenCalled()
    } finally {
      URL.createObjectURL = originalUrl
      URL.revokeObjectURL = originalRevoke ?? (() => undefined)
      click.mockRestore()
    }
  })

  it('renders in English', () => {
    setup('en')
    expect(screen.getByText('Trace comparison')).toBeTruthy()
    expect(screen.getByText('Baseline')).toBeTruthy()
    expect(screen.getByText('Exit compare')).toBeTruthy()
  })

  it('tells the user when there is nothing to compare', () => {
    const { sessions, cards } = fixtures()
    render(
      <I18nProvider initialLocale="zh-CN">
        <ComparePanel
          sessions={[sessions[0]!]}
          cards={cards}
          initialBaseId={sessions[0]!.id}
          onClose={() => undefined}
        />
      </I18nProvider>,
    )
    expect(screen.getByText(/至少需要两条轨迹/)).toBeTruthy()
  })
})
