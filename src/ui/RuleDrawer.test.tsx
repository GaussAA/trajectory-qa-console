// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  const parsed = analyze({ source: TRACE, label: 'trace.json' })
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value.sessions.map((session) => ({ id: session.id, trajectory: session.trajectory }))
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

describe('RuleDrawer pack comparison', () => {
  // 只有一条 error 的轨迹：禁用该规则后，封顶解除，分数差才可见
  const SINGLE_ERROR = JSON.stringify([
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '查一下' },
    { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '结果' },
    { role: 'assistant', content: '答复完毕' },
  ])

  function lenientVariant() {
    return {
      id: 'v-lenient',
      name: '宽松口径',
      pack: {
        ...DEFAULT_PACK,
        name: '宽松',
        rules: DEFAULT_PACK.rules.map((rule) =>
          rule.id === 'structure-invalid-args' ? { ...rule, enabled: false } : rule,
        ),
      },
      savedAt: '2026-10-23T10:00:00.000Z',
    }
  }

  function setupSingleError(props: Partial<Parameters<typeof RuleDrawer>[0]> = {}) {
    const parsed = analyze({ source: SINGLE_ERROR, label: 'single-error.json' })
    if (!parsed.ok) throw new Error(parsed.error.message)
    return setup({
      sessions: parsed.value.sessions.map((session) => ({ id: session.id, trajectory: session.trajectory })),
      ...props,
    })
  }

  it('compares the current pack against a variant across loaded sessions', () => {
    const { container } = setupSingleError({ variants: [lenientVariant()] })

    fireEvent.click(screen.getByText('口径对比'))
    // 默认对照是「内置中文包」；切到变体后才与当前包有差异
    const selects = container.querySelectorAll('.packcmp-pickers select')
    expect(selects).toHaveLength(2)
    fireEvent.change(selects[1] as HTMLSelectElement, { target: { value: 'v-lenient' } })

    const table = container.querySelector('.packcmp-table') as HTMLElement
    expect(table.textContent).toContain('single-error.json')
    // 禁掉唯一一条 error：封顶解除，对照分应高于基准分
    const cells = [...table.querySelectorAll('.packcmp-row:not(.packcmp-head) .num')].map((node) =>
      Number(node.textContent),
    )
    expect(cells).toHaveLength(6) // 一条轨迹 base/target/delta + 平均行三格
    expect(cells[2] as number).toBeGreaterThan(0)
    expect(cells[5] as number).toBeGreaterThan(0)
  })

  it('says so when both sides are the same pack', () => {
    const { container } = setup()
    fireEvent.click(screen.getByText('口径对比'))
    const selects = container.querySelectorAll('.packcmp-pickers select')
    fireEvent.change(selects[1] as HTMLSelectElement, { target: { value: 'current' } })
    expect(container.querySelector('.packcmp-table')).toBeNull()
    expect(screen.getByText('两份口径相同，没有可比的差异。')).toBeTruthy()
  })
})

describe('RuleDrawer variants', () => {
  function variantProps() {
    return {
      variants: [
        {
          id: 'v1',
          name: '宽松口径',
          pack: DEFAULT_PACK,
          savedAt: '2026-10-23T10:00:00.000Z',
        },
      ],
      activeVariantId: null as string | null,
    }
  }

  it('saves the current draft (including unapplied tuning) as a variant', async () => {
    const onSaveVariant = vi.fn()
    const { container } = setup({ ...variantProps(), onSaveVariant })

    // 先调参（只改草稿，不点「校验并应用」）
    const input = row(container, 'structure-invalid-args').querySelector('input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '5' } })
    await waitFor(() => expect(hitCount(container, 'structure-invalid-args')).toBe('0'))

    fireEvent.change(screen.getByLabelText('存为变体'), { target: { value: '宽松阈值' } })
    fireEvent.click(screen.getByRole('button', { name: '存为变体' }))

    expect(onSaveVariant).toHaveBeenCalledTimes(1)
    const [name, savedPack] = onSaveVariant.mock.calls[0] as [string, typeof DEFAULT_PACK]
    expect(name).toBe('宽松阈值')
    // 草稿里的阈值进包：未应用也能存
    const rule = savedPack.rules.find((item) => item.id === 'structure-invalid-args')
    expect(rule?.expr).toContain('5')
    expect(screen.getByText('已保存变体「宽松阈值」')).toBeTruthy()
  })

  it('refuses to save a draft that is not a valid pack', () => {
    const onSaveVariant = vi.fn()
    const { container } = setup({ ...variantProps(), onSaveVariant })

    // 解析失败走另一条提示；这里用「能解析但不合法」的包，验证校验失败路径
    fireEvent.change(container.querySelector('.pack-editor') as HTMLTextAreaElement, {
      target: { value: '{}' },
    })
    fireEvent.change(screen.getByLabelText('存为变体'), { target: { value: '坏包' } })
    fireEvent.click(screen.getByRole('button', { name: '存为变体' }))

    expect(onSaveVariant).not.toHaveBeenCalled()
    expect(screen.getByText('当前草稿不是合法规则包，先校验通过再保存')).toBeTruthy()
  })

  it('applies and removes variants through the callbacks', () => {
    const onApplyVariant = vi.fn()
    const onRemoveVariant = vi.fn()
    setup({
      ...variantProps(),
      activeVariantId: 'v1',
      onApplyVariant,
      onRemoveVariant,
    })

    // 生效中的变体「应用」置灰
    const applyButton = screen.getByRole('button', { name: '应用' }) as HTMLButtonElement
    expect(applyButton.disabled).toBe(true)
    expect(screen.getByText('生效中')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '删除 宽松口径' }))
    expect(onRemoveVariant).toHaveBeenCalledWith('v1')
    expect(onApplyVariant).not.toHaveBeenCalled()
  })

  it('renames a variant inline via the pencil button', () => {
    const onRenameVariant = vi.fn()
    setup({ variants: [renameTarget()], onRenameVariant })

    fireEvent.click(screen.getByRole('button', { name: '重命名变体 宽松口径' }))
    const input = screen.getByLabelText('重命名变体') as HTMLInputElement
    expect(input.value).toBe('宽松口径')

    fireEvent.change(input, { target: { value: '宽松 v2' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onRenameVariant).toHaveBeenCalledWith('v1', '宽松 v2')
    expect(screen.queryByLabelText('重命名变体')).toBeNull()
  })

  it('cancels only the rename on Esc, instead of closing the whole drawer', () => {
    const onClose = vi.fn()
    const onRenameVariant = vi.fn()
    setup({ variants: [renameTarget()], onRenameVariant, onClose })

    fireEvent.click(screen.getByRole('button', { name: '重命名变体 宽松口径' }))
    const input = screen.getByLabelText('重命名变体') as HTMLInputElement
    fireEvent.change(input, { target: { value: '改到一半' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    // 取消的是重命名，不是整个抽屉：抽屉里可能还有没存的 JSON 草稿。
    expect(onClose).not.toHaveBeenCalled()
    expect(onRenameVariant).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('重命名变体')).toBeNull()
  })

  it('still closes on Esc when nothing inside the drawer is handling it', () => {
    const onClose = vi.fn()
    setup({ onClose })

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('treats an empty rename as cancel', () => {
    const onRenameVariant = vi.fn()
    setup({ variants: [renameTarget()], onRenameVariant })

    fireEvent.click(screen.getByRole('button', { name: '重命名变体 宽松口径' }))
    const input = screen.getByLabelText('重命名变体') as HTMLInputElement
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onRenameVariant).not.toHaveBeenCalled()
  })

  it('exports all variants as one bundle and imports from a parsed file', async () => {
    // 导出内容已由 persistence 的 round-trip 测试覆盖，这里只验证接线
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const onExportVariants = vi.fn()
    const onImportVariants = vi.fn()

    try {
      const { container } = setup({ variants: [renameTarget()], onExportVariants, onImportVariants })

      fireEvent.click(screen.getByRole('button', { name: '打包导出' }))
      expect(onExportVariants).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByRole('button', { name: '导入变体' }))
      // 抽屉里有两个 file input（规则包 / 变体），定位变体自己的那个
      const input = container.querySelector('.variant-section input[type=file]') as HTMLInputElement
      const file = new File([JSON.stringify({ variants: [renameTarget()] })], 'variants.json', {
        type: 'application/json',
      })
      Object.defineProperty(input, 'files', { value: [file] })
      fireEvent.change(input)
      await waitFor(() => expect(onImportVariants).toHaveBeenCalledTimes(1))
      // 抽屉只负责 JSON.parse；格式校验在 parsePackVariants（持久化测试已覆盖）
      expect(onImportVariants.mock.calls[0]?.[0]).toMatchObject({ variants: [expect.anything()] })
    } finally {
      click.mockRestore()
    }
  })

  function renameTarget() {
    return {
      id: 'v1',
      name: '宽松口径',
      pack: DEFAULT_PACK,
      savedAt: '2026-10-23T10:00:00.000Z',
    }
  }

  it('shows the empty hint when nothing is saved', () => {
    setup()
    expect(screen.getByText('还没有保存的变体。')).toBeTruthy()
  })
})

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
