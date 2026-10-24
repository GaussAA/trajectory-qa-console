// @vitest-environment jsdom
/** 面板边界在整个 App 里的接线：某一步让检视器渲染失败，用户按 ↓ 走到下一步，
 *  失败页应当自己消失，而不是停在原地等人点「重试」（对确定性的渲染错误，重试只会再抛一次）。
 *
 *  ErrorBoundary 自己的行为在 ErrorBoundary.test.tsx 里；这里只验证 App 把 resetKey 接对了。 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSyncAnalyzer } from '../app/analyzer'
import { createMemoryStorage, createPersistence } from '../app/persistence'
import { createTelemetry } from '../app/telemetry'
import { I18nProvider } from '../i18n'
import App from './App'

// 记下第一次渲染到的那一步，之后只有这一步会抛错。
const poison = vi.hoisted(() => ({ index: null as number | null }))

vi.mock('./Inspector', () => ({
  Inspector: ({ step }: { step: { index: number } | null }) => {
    if (step) {
      if (poison.index === null) poison.index = step.index
      if (step.index === poison.index) throw new Error('inspector boom')
    }
    return 'inspector ok'
  },
}))

beforeEach(() => {
  poison.index = null
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('panel error boundaries inside App', () => {
  it('recovers on its own when the user moves to a step that renders fine', async () => {
    const user = userEvent.setup()
    render(
      <I18nProvider initialLocale="zh-CN">
        <App
          analyzer={createSyncAnalyzer()}
          persistence={createPersistence(createMemoryStorage())}
          telemetry={createTelemetry()}
        />
      </I18nProvider>,
    )
    await user.click(screen.getByRole('button', { name: /载入示例/ }))

    // 选中的那一步让检视器抛错：只有检视器掉了，其余面板还在
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('检视器不可用'))
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(document.querySelector('.step-row')).not.toBeNull()

    // 走到下一步：失败页自己走，不用点「重试」
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByText('inspector ok')).toBeTruthy()
  })

  it('comes back to the failure when the user returns to the broken step', async () => {
    const user = userEvent.setup()
    render(
      <I18nProvider initialLocale="zh-CN">
        <App
          analyzer={createSyncAnalyzer()}
          persistence={createPersistence(createMemoryStorage())}
          telemetry={createTelemetry()}
        />
      </I18nProvider>,
    )
    await user.click(screen.getByRole('button', { name: /载入示例/ }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())

    // 回到出错的那一步：如实再显示失败，不装作没事
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('检视器不可用'))
  })
})
