// @vitest-environment jsdom
/** 抽屉的焦点陷阱此前只监听对话框节点上的 Tab：焦点一旦落到框外（点了遮罩、脚本把焦点挪走），
 *  Tab 就在页面其余部分里走，抽屉形同虚设。 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useFocusTrap } from './useFocusTrap'

function Dialog({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, active)
  return (
    <div>
      <button type="button">outside-before</button>
      <div ref={ref} role="dialog">
        <button type="button">first</button>
        <button type="button">last</button>
      </div>
      <button type="button">outside-after</button>
    </div>
  )
}

// jsdom 没有布局，offsetParent 恒为 null，焦点陷阱会把所有元素都当成「不可见」。
// 这里让它按「在文档里就算可见」来答，才能测到真实的 Tab 行为。
const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      return this.isConnected ? document.body : null
    },
  })
})
afterEach(() => {
  cleanup()
  if (original) Object.defineProperty(HTMLElement.prototype, 'offsetParent', original)
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetParent
})

const pressTab = (shift = false) => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey: shift })

describe('useFocusTrap', () => {
  it('moves focus into the dialog when it opens', () => {
    render(<Dialog active />)
    expect(document.activeElement).toBe(screen.getByText('first'))
  })

  it('wraps Tab from the last control back to the first, and Shift+Tab the other way', () => {
    render(<Dialog active />)
    screen.getByText('last').focus()
    pressTab()
    expect(document.activeElement).toBe(screen.getByText('first'))

    pressTab(true)
    expect(document.activeElement).toBe(screen.getByText('last'))
  })

  it('pulls focus back in when it has escaped to the page behind', () => {
    render(<Dialog active />)
    // 点了遮罩之类：焦点落在框外
    screen.getByText('outside-after').focus()
    expect(document.activeElement).toBe(screen.getByText('outside-after'))

    pressTab()
    // 之前这个 Tab 没人接，焦点会继续往页面后面走
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  })

  it('pulls focus back in on Shift+Tab from outside too', () => {
    render(<Dialog active />)
    screen.getByText('outside-before').focus()
    pressTab(true)
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  })

  it('lets only the most recently opened dialog act when two are open', () => {
    function Two({ second }: { second: boolean }) {
      const a = useRef<HTMLDivElement>(null)
      const b = useRef<HTMLDivElement>(null)
      useFocusTrap(a, true)
      useFocusTrap(b, second)
      return (
        <div>
          <div ref={a} role="dialog" aria-label="a">
            <button type="button">a-first</button>
            <button type="button">a-last</button>
          </div>
          {second && (
            <div ref={b} role="dialog" aria-label="b">
              <button type="button">b-first</button>
              <button type="button">b-last</button>
            </div>
          )}
        </div>
      )
    }
    const { rerender } = render(<Two second={false} />)
    rerender(<Two second />)
    expect(document.activeElement).toBe(screen.getByText('b-first'))

    // 焦点在 b 里：Tab 从 b 的末尾绕回 b 的开头。
    screen.getByText('b-last').focus()
    pressTab()
    expect(document.activeElement).toBe(screen.getByText('b-first'))
  })

  it('does not interfere with ordinary Tab movement inside the top dialog', () => {
    function Two({ second }: { second: boolean }) {
      const a = useRef<HTMLDivElement>(null)
      const b = useRef<HTMLDivElement>(null)
      useFocusTrap(a, true)
      useFocusTrap(b, second)
      return (
        <div>
          <div ref={a} role="dialog" aria-label="a">
            <button type="button">a-first</button>
          </div>
          {second && (
            <div ref={b} role="dialog" aria-label="b">
              <button type="button">b-one</button>
              <button type="button">b-two</button>
              <button type="button">b-three</button>
            </div>
          )}
        </div>
      )
    }
    const { rerender } = render(<Two second={false} />)
    rerender(<Two second />)

    // 焦点在 b 的中间控件上：Tab 应当交给浏览器，自然走到下一个。
    // 如果下面那个对话框的陷阱也响应，它会认为焦点在自己「框外」，preventDefault 并把焦点拽走，
    // 用户在最上层的对话框里就按不动 Tab 了。
    screen.getByText('b-two').focus()
    const notPrevented = fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab' })
    expect(notPrevented).toBe(true)
    expect(document.activeElement).toBe(screen.getByText('b-two'))
  })

  it('hands control back to the earlier dialog when the later one closes', () => {
    function Two({ second }: { second: boolean }) {
      const a = useRef<HTMLDivElement>(null)
      const b = useRef<HTMLDivElement>(null)
      useFocusTrap(a, true)
      useFocusTrap(b, second)
      return (
        <div>
          <div ref={a} role="dialog" aria-label="a">
            <button type="button">a-first</button>
            <button type="button">a-last</button>
          </div>
          {second && (
            <div ref={b} role="dialog" aria-label="b">
              <button type="button">b-first</button>
            </div>
          )}
        </div>
      )
    }
    const { rerender } = render(<Two second />)
    rerender(<Two second={false} />)
    screen.getByText('a-last').focus()
    pressTab()
    expect(document.activeElement).toBe(screen.getByText('a-first'))
  })

  it('does nothing while inactive, and gives focus back on close', () => {
    const { rerender } = render(<Dialog active={false} />)
    screen.getByText('outside-after').focus()
    pressTab()
    expect(document.activeElement).toBe(screen.getByText('outside-after'))

    screen.getByText('outside-before').focus()
    rerender(<Dialog active />)
    expect(document.activeElement).toBe(screen.getByText('first'))
    rerender(<Dialog active={false} />)
    expect(document.activeElement).toBe(screen.getByText('outside-before'))
  })
})
