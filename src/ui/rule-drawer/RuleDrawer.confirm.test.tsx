// @vitest-environment jsdom
/** 抽屉里改到一半的 JSON 草稿，被一次手滑（点到遮罩、顺手按了 Esc）整个丢掉。
 *  这里锁的是：没改动时照旧一下就关；有改动时先问一句，并且问的是对的那几条关闭路径。 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PACK } from '../../core/rules/builtin-pack'
import { I18nProvider } from '../../i18n'
import { RuleDrawer } from './RuleDrawer'

afterEach(cleanup)

type Props = Parameters<typeof RuleDrawer>[0]

function tree(props: Partial<Props> = {}, locale: 'zh-CN' | 'en' = 'zh-CN') {
  return (
    <I18nProvider initialLocale={locale}>
      <RuleDrawer
        open
        pack={DEFAULT_PACK}
        sessions={[]}
        ruleIssues={[]}
        onClose={() => undefined}
        onApply={() => undefined}
        {...props}
      />
    </I18nProvider>
  )
}

/** 原始 JSON 在默认收起的 <details> 里，但 textarea 一直在 DOM 里。 */
function editor(): HTMLTextAreaElement {
  const found = document.querySelector('textarea.pack-editor')
  if (!found) throw new Error('editor not rendered')
  return found as HTMLTextAreaElement
}

function edit(value: string) {
  fireEvent.change(editor(), { target: { value } })
}

const backdrop = () => document.querySelector('.drawer-backdrop') as HTMLElement
const confirmBar = () => screen.queryByRole('alertdialog')

describe('closing the rules drawer', () => {
  it('closes at once when nothing was edited', () => {
    const onClose = vi.fn()
    render(tree({ onClose }))
    fireEvent.mouseDown(backdrop())
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(confirmBar()).toBeNull()
  })

  it('asks first when the draft has unsaved edits, and does not close yet', () => {
    const onClose = vi.fn()
    render(tree({ onClose }))
    edit(editor().value.replace('"version": 1', '"version": 2'))

    fireEvent.mouseDown(backdrop())

    expect(onClose).not.toHaveBeenCalled()
    expect(confirmBar()).not.toBeNull()
    expect(screen.getByRole('button', { name: '继续编辑' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '放弃修改并关闭' })).toBeTruthy()
  })

  it('"keep editing" dismisses the question and keeps the draft', () => {
    const onClose = vi.fn()
    render(tree({ onClose }))
    const changed = editor().value.replace('"version": 1', '"version": 2')
    edit(changed)
    fireEvent.mouseDown(backdrop())

    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))

    expect(confirmBar()).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(editor().value).toBe(changed)
  })

  it('"discard and close" closes', () => {
    const onClose = vi.fn()
    render(tree({ onClose }))
    edit(editor().value.replace('"version": 1', '"version": 2'))
    fireEvent.mouseDown(backdrop())

    fireEvent.click(screen.getByRole('button', { name: '放弃修改并关闭' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not count a pure reformat as an edit', () => {
    const onClose = vi.fn()
    render(tree({ onClose }))
    // 内容一模一样，只是缩进变了：不该拿「放弃修改吗」去吓用户
    edit(JSON.stringify(JSON.parse(editor().value)))
    fireEvent.mouseDown(backdrop())
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(confirmBar()).toBeNull()
  })

  it('counts a draft that no longer parses as an edit', () => {
    const onClose = vi.fn()
    render(tree({ onClose }))
    edit('{ "name": ')
    fireEvent.mouseDown(backdrop())
    expect(onClose).not.toHaveBeenCalled()
    expect(confirmBar()).not.toBeNull()
  })

  it('does not treat a click inside the panel as a click on the backdrop', () => {
    const onClose = vi.fn()
    render(tree({ onClose }))
    edit('{ "name": ')
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    expect(confirmBar()).toBeNull()
  })

  describe('Esc', () => {
    it('closes at once when clean', () => {
      const onClose = vi.fn()
      render(tree({ onClose }))
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('asks first when dirty, and a second Esc dismisses the question instead of closing', () => {
      const onClose = vi.fn()
      render(tree({ onClose }))
      edit('{ "name": ')

      fireEvent.keyDown(window, { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()
      expect(confirmBar()).not.toBeNull()

      // 再按一次 Esc 是「算了，不关了」，不是「确认丢弃」——否则连按两下 Esc 就等于没有确认
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()
      expect(confirmBar()).toBeNull()
    })
  })

  describe('the other close buttons', () => {
    it('the header ✕ asks like Esc does', () => {
      const onClose = vi.fn()
      render(tree({ onClose }))
      edit('{ "name": ')
      fireEvent.click(screen.getByRole('button', { name: '关闭' }))
      expect(onClose).not.toHaveBeenCalled()
      expect(confirmBar()).not.toBeNull()
    })

    it('the footer 取消 button is an explicit discard and closes straight away', () => {
      const onClose = vi.fn()
      render(tree({ onClose }))
      edit('{ "name": ')
      fireEvent.click(screen.getByRole('button', { name: '取消' }))
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  it('forgets a pending question when the drawer is closed and reopened', () => {
    const view = render(tree())
    edit('{ "name": ')
    fireEvent.mouseDown(backdrop())
    expect(confirmBar()).not.toBeNull()

    view.rerender(tree({ open: false }))
    view.rerender(tree({ open: true }))

    expect(confirmBar()).toBeNull()
  })

  it('says it in English too', () => {
    render(tree({}, 'en'))
    edit('{ "name": ')
    fireEvent.mouseDown(backdrop())
    expect(screen.getByRole('button', { name: 'Keep editing' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Discard changes and close' })).toBeTruthy()
  })
})
