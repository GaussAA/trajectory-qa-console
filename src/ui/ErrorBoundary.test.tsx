// @vitest-environment jsdom
/** 面板级错误边界：一个面板渲染失败不该拖垮整页（不变量 5），也不该一直卡在失败页上。
 *
 *  此前这个组件完全没有测试，而它有两个真实缺口：只能靠手点「重试」恢复（对确定性的渲染错误，
 *  重试只会再抛一次），以及切到另一个会话/步骤后失败页还留在原地。 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { ErrorBoundary } from './ErrorBoundary'

/** 在 `bad` 为真时抛错的子组件。 */
function Probe({ bad, label = 'ok' }: { bad: boolean; label?: string }) {
  if (bad) throw new Error('渲染炸了')
  return <p>{label}</p>
}

function renderBoundary(ui: React.ReactElement) {
  return render(<I18nProvider initialLocale="zh-CN">{ui}</I18nProvider>)
}

beforeEach(() => {
  // React 会把被捕获的渲染错误打到 console.error；这里是故意抛的，别污染输出。
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    renderBoundary(
      <ErrorBoundary nameKey="panel.timeline">
        <Probe bad={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('ok')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('contains a failing child to a fallback that names the panel and shows the message', () => {
    renderBoundary(
      <div>
        <ErrorBoundary nameKey="panel.timeline">
          <Probe bad />
        </ErrorBoundary>
        <p>旁边的面板</p>
      </div>,
    )
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('时间线面板')
    expect(alert.textContent).toContain('渲染炸了')
    // 其余部分不受影响
    expect(screen.getByText('旁边的面板')).toBeTruthy()
  })

  it('reports the error to the caller', () => {
    const onError = vi.fn()
    renderBoundary(
      <ErrorBoundary nameKey="panel.timeline" onError={onError}>
        <Probe bad />
      </ErrorBoundary>,
    )
    expect(onError).toHaveBeenCalledTimes(1)
    const reported = onError.mock.calls[0]?.[0] as Error | undefined
    expect(reported?.message).toBe('渲染炸了')
  })

  it('recovers on Retry once the cause is gone', () => {
    let bad = true
    const view = (
      <ErrorBoundary nameKey="panel.timeline">
        <Probe bad={bad} />
      </ErrorBoundary>
    )
    const { rerender } = renderBoundary(view)
    expect(screen.getByRole('alert')).toBeTruthy()

    bad = false
    rerender(
      <I18nProvider initialLocale="zh-CN">
        <ErrorBoundary nameKey="panel.timeline">
          <Probe bad={bad} />
        </ErrorBoundary>
      </I18nProvider>,
    )
    // 原因消失了，但失败页不会自己走：这是旧行为，也是缺口之一
    expect(screen.getByRole('alert')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '重试该面板' }))
    expect(screen.getByText('ok')).toBeTruthy()
  })

  it('keeps failing after Retry when the error is deterministic, without looping', () => {
    renderBoundary(
      <ErrorBoundary nameKey="panel.timeline">
        <Probe bad />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: '重试该面板' }))
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})

describe('ErrorBoundary resetKey', () => {
  function Harness({ resetKey, bad }: { resetKey: string; bad: boolean }) {
    return (
      <I18nProvider initialLocale="zh-CN">
        <ErrorBoundary nameKey="panel.inspector" resetKey={resetKey}>
          <Probe bad={bad} label={`step ${resetKey}`} />
        </ErrorBoundary>
      </I18nProvider>
    )
  }

  it('clears the fallback by itself when the key changes, e.g. the user moves to another step', () => {
    // 第 3 步坏了，第 4 步是好的。
    const { rerender } = render(<Harness resetKey="3" bad />)
    expect(screen.getByRole('alert')).toBeTruthy()

    rerender(<Harness resetKey="4" bad={false} />)

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('step 4')).toBeTruthy()
  })

  it('stays on the fallback while the key is unchanged', () => {
    const { rerender } = render(<Harness resetKey="3" bad />)
    rerender(<Harness resetKey="3" bad />)
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('shows the fallback again if the new key is broken too, and does not loop', () => {
    const { rerender } = render(<Harness resetKey="3" bad />)
    rerender(<Harness resetKey="4" bad />)
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('does nothing extra when there is no error and the key changes', () => {
    const { rerender } = render(<Harness resetKey="3" bad={false} />)
    rerender(<Harness resetKey="4" bad={false} />)
    expect(screen.getByText('step 4')).toBeTruthy()
  })
})
