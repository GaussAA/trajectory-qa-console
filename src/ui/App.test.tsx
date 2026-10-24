// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSyncAnalyzer } from '../app/analyzer'
import { createMemoryStorage, createPersistence } from '../app/persistence'
import { createTelemetry } from '../app/telemetry'
import App from './App'
import { I18nProvider, type Locale } from '../i18n'

afterEach(() => {
  cleanup()
  // 有些用例会改地址栏（`?agent=` 决定是否出现 AI 诊断按钮），用完必须还原，
  // 否则后面的用例会莫名其妙多出一个按钮。
  window.history.replaceState({}, '', '/')
})

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
  it('keeps topbar labels distinct once AI diagnosis is enabled', async () => {
    window.history.replaceState({}, '', '/?agent=http://127.0.0.1:7788')
    const { user } = setup()
    await loadSamples(user)

    const topbar = document.querySelector('.topbar-actions')
    const labels = [...(topbar?.querySelectorAll('button') ?? [])].map((button) =>
      (button.textContent ?? '').trim(),
    )
    // 曾经有两个按钮都叫「诊断」：一个是诊断日志，一个是 AI 诊断。并排时没人分得清。
    const duplicates = [...new Set(labels.filter((label, index) => labels.indexOf(label) !== index))]
    expect(labels.length).toBeGreaterThan(0)
    expect(duplicates).toEqual([])
  })

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

  it('exports a self-contained HTML report', async () => {
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
      const { user } = setup()
      const button = screen.getByRole('button', { name: 'HTML 报告' }) as HTMLButtonElement
      expect(button.disabled).toBe(true)

      await loadSamples(user)
      await waitFor(() =>
        expect((screen.getByRole('button', { name: 'HTML 报告' }) as HTMLButtonElement).disabled).toBe(false),
      )
      await user.click(screen.getByRole('button', { name: 'HTML 报告' }))

      await waitFor(() => expect(bodies).toHaveLength(1))
      expect(bodies[0]?.startsWith('<!doctype html>')).toBe(true)
      expect(bodies[0]).toContain('轨迹质检报告')
      expect(click).toHaveBeenCalled()
      expect(await screen.findByText('HTML 报告已导出')).toBeTruthy()
    } finally {
      URL.createObjectURL = originalUrl
      // jsdom 没有 revokeObjectURL：若还原成 undefined，downloadFile 里 2s 后的
      // 定时器会抛未捕获异常，把整轮覆盖率判成失败。留一个 no-op 更安全。
      URL.revokeObjectURL = originalRevoke ?? (() => undefined)
      click.mockRestore()
    }
  })

  it('renames a session and shows the new name everywhere it matters', async () => {
    const { user } = setup()
    await loadSamples(user)

    const item = await screen.findByRole('button', { name: /demo-01/ })
    const row = item.closest('.session-row') as HTMLElement
    await user.click(within(row).getByRole('button', { name: '重命名会话' }))

    const nameInput = within(row).getByLabelText('会话名称')
    await user.clear(nameInput)
    await user.type(nameInput, '第三版')
    await user.type(within(row).getByLabelText('会话备注'), '改了 system prompt')
    await user.click(within(row).getByRole('button', { name: '保存' }))

    expect(await screen.findByRole('button', { name: /第三版/ })).toBeTruthy()
    // 评分面板标题跟随重命名，备注出现在列表里
    expect(screen.getByRole('heading', { name: '第三版' })).toBeTruthy()
    expect(screen.getByText('改了 system prompt')).toBeTruthy()
  })

  it('restores the file name when both fields are cleared', async () => {
    const { user } = setup()
    await loadSamples(user)

    const item = await screen.findByRole('button', { name: /demo-01/ })
    let row = item.closest('.session-row') as HTMLElement
    await user.click(within(row).getByRole('button', { name: '重命名会话' }))
    const nameInput = within(row).getByLabelText('会话名称')
    await user.type(nameInput, '临时名字')
    await user.click(within(row).getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('button', { name: /临时名字/ })).toBeTruthy()

    const renamed = screen.getByRole('button', { name: /临时名字/ })
    row = renamed.closest('.session-row') as HTMLElement
    await user.click(within(row).getByRole('button', { name: '重命名会话' }))
    await user.click(within(row).getByRole('button', { name: '恢复原名' }))
    await user.click(within(row).getByRole('button', { name: '保存' }))

    expect(await screen.findByRole('button', { name: /demo-01/ })).toBeTruthy()
  })

  it('tags a session and filters the list by tag', async () => {
    const { user } = setup()
    await loadSamples(user)
    // 「全部」在问题清单的严重度筛选里也有；标签筛选行以容器存在与否判断
    expect(document.querySelector('.tag-filter')).toBeNull()

    // 给第一条打标签
    const item = await screen.findByRole('button', { name: /demo-01/ })
    const row = item.closest('.session-row') as HTMLElement
    await user.click(within(row).getByRole('button', { name: '重命名会话' }))
    await user.type(within(row).getByLabelText('标签（逗号分隔）'), '回归, prompt-v3')
    await user.click(within(row).getByRole('button', { name: '保存' }))

    // 行内 chips + 筛选行出现（行内与筛选行都有「回归」，取筛选行的）
    await screen.findAllByText('回归')
    const filterRow = document.querySelector('.tag-filter') as HTMLElement
    expect(filterRow).toBeTruthy()
    await user.click(within(filterRow).getByRole('button', { name: '回归' }))

    // 只剩打了该标签的一条；计数显示 1/4
    await waitFor(() => expect(screen.getAllByRole('button', { name: /demo-0/ })).toHaveLength(1))
    expect(screen.getByText('1/4')).toBeTruthy()

    // 回到「全部」恢复（同样取标签筛选行的）
    await user.click(within(filterRow).getByRole('button', { name: '全部' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: /demo-0/ })).toHaveLength(4))
  })

  it('batch-renames the selected sessions with a prefix', async () => {
    const { user } = setup()
    await loadSamples(user)

    await user.click(screen.getByRole('button', { name: '选择' }))
    const items = screen.getAllByRole('button', { name: /demo-0/ })
    await user.click(items[0]!)
    await user.click(items[1]!)
    expect(screen.getByText('已选 2 条')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '批量命名' }))
    await user.type(screen.getByLabelText('名称前缀'), 'exp')
    expect(screen.getByText(/exp-01/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '应用命名' }))
    expect(await screen.findByRole('button', { name: /exp-01/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /exp-02/ })).toBeTruthy()
    // 选完即退出选择态，避免误触下一次批量操作
    expect(screen.queryByText('已选 2 条')).toBeNull()
  })

  it('deletes selected sessions only after a second confirmation', async () => {
    const { user } = setup()
    await loadSamples(user)
    expect(screen.getAllByRole('button', { name: /demo-0/ })).toHaveLength(4)

    await user.click(screen.getByRole('button', { name: '选择' }))
    const items = screen.getAllByRole('button', { name: /demo-0/ })
    await user.click(items[0]!)
    await user.click(items[1]!)

    await user.click(screen.getByRole('button', { name: '删除所选' }))
    // 第一次点击只进入确认态，不删
    expect(screen.getAllByRole('button', { name: /demo-0/ })).toHaveLength(4)
    await user.click(screen.getByRole('button', { name: '确认删除 2 条' }))

    await waitFor(() => expect(screen.getAllByRole('button', { name: /demo-0/ })).toHaveLength(2))
    // 删完自动退出选择态
    expect(screen.queryByText(/已选/)).toBeNull()
    expect(screen.queryByRole('button', { name: '退出选择' })).toBeNull()
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

  it('moves between steps with the arrow keys', async () => {
    const { user } = setup()
    await loadSamples(user)

    // 64 步的轨迹一格格点太慢；↑/↓ 是最基本的键盘导航。
    const selected = () => document.querySelector('.step-row.selected')?.textContent ?? ''
    const before = selected()
    expect(before).not.toBe('')

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    await waitFor(() => expect(selected()).not.toBe(before))

    fireEvent.keyDown(window, { key: 'ArrowUp' })
    await waitFor(() => expect(selected()).toBe(before))
  })

  it('does not steal arrow keys while typing in a field', async () => {
    const { user } = setup()
    await loadSamples(user)

    const selected = () => document.querySelector('.step-row.selected')?.textContent ?? ''
    const before = selected()
    const field = screen.getByPlaceholderText(/结论无引用/)
    await user.click(field)
    fireEvent.keyDown(field, { key: 'ArrowDown' })

    // 输入框里的方向键要能移动光标，不能被全局快捷键抢走。
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(selected()).toBe(before)
  })

  it('offers a session picker for narrow layouts, and it actually switches', async () => {
    const { user } = setup()
    await loadSamples(user)

    // 窄屏（≤1279）左栏整个收起，会话切换靠这个下拉。
    // 它在宽屏时被 CSS 隐藏，但 DOM 里一直在——所以要验「切换是否真的生效」，
    // 而不是「有没有这个元素」。
    const picker = screen.getByRole('combobox', { name: '会话面板' }) as HTMLSelectElement
    expect(picker.options.length).toBeGreaterThan(1)

    // 选项的 value 是内部 id，标签才是文件名——按标签找再取它的 value。
    const target = [...picker.options].find((option) => option.textContent?.includes('demo-02'))
    expect(target).toBeTruthy()
    await user.selectOptions(picker, target?.value as string)

    await waitFor(() => expect(screen.getByRole('heading', { name: /demo-02/ })).toBeTruthy())
  })

  it('collapses the findings panel to one line when no rule fired', async () => {
    const { user } = setup()
    await loadSamples(user)

    // demo-01 是满分轨迹：右栏不该被「0/0 空态」占掉一半，
    // 那块高度要给「人工标注」——右栏的核心动作。
    expect(screen.getByText('这条轨迹没有命中任何规则')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /全部维度/ })).toBeNull()
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

    // demo-01 没有命中任何规则，问题清单会收成一行，筛选器也就不该出现。
    // 换成有问题的那条会话再验筛选器（它只在有东西可筛时才有意义）。
    await user.click(screen.getByRole('button', { name: /demo-02/ }))
    const errorFilter = await screen.findByRole('button', { name: /严重/ })
    expect(errorFilter.getAttribute('aria-pressed')).toBe('false')
    await user.click(errorFilter)
    expect(errorFilter.getAttribute('aria-pressed')).toBe('true')
  })
})
