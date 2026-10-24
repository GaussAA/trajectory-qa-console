// @vitest-environment node
/** 响应式体系的结构性守卫。
 *
 *  为什么需要它：这一版的响应式曾经只是「几个常用宽度的手工补丁」——
 * 三个断点、零个容器查询、min-width 把视口撑破。补丁很容易被后人不经意改回去，
 * 而「界面看着还行」从来不是可测量的判据。这里把体系的关键特征钉成断言：
 * 少一个，测试就红。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const layout = readFileSync('src/styles/layout.css', 'utf8')
const responsive = readFileSync('src/styles/responsive.css', 'utf8')
const score = readFileSync('src/styles/components/score.css', 'utf8')
const session = readFileSync('src/styles/components/session.css', 'utf8')

describe('响应式体系', () => {
  it('三栏各自是容器：栏内组件按自己的宽度决策，而不是按视口猜', () => {
    expect(layout).toContain('container-type: inline-size')
    expect(layout).toContain('container-name: col')
  })

  it('关键组件各自用上了容器查询（按文件断言，不许用别处的来充数）', () => {
    // 四维的列数看的是中栏多宽
    expect(score).toContain('@container col')
    // 图标条看的是左栏多窄
    expect(session).toContain('@container col')
  })

  it('有高度分档：宽度决定几栏，高度决定每栏多紧凑', () => {
    expect(responsive).toMatch(/@media \(max-height: \d+px\)/)
  })

  it('不再有把视口撑破的 min-width（那是横向滚动条的老来源）', () => {
    // 允许品牌区那点 208px 之类的合理值，禁止任何 500px 以上的硬下限。
    // 排除 @media (min-width: …) ——那是断点条件，不是布局下限。
    const offenders = [
      ...`${layout}${responsive}`.matchAll(/(?<!\()\bmin-width:\s*([5-9]\d\d|\d{4,})px/g),
    ]
    expect(offenders.map((match) => match[0])).toEqual([])
  })

  it('左栏宽度由变量决定，窄屏有图标条形态', () => {
    expect(layout).toContain('--left-w')
    expect(responsive).toMatch(/--left-w:\s*56px/)
    // 图标条内容靠容器查询收敛，不是靠视口
    expect(session).toContain('@container col (max-width: 120px)')
  })

  it('极窄屏有单栏降级，且页面纵向滚动（不靠横向滚动条撑）', () => {
    expect(responsive).toMatch(/@media \(max-width: 1023px\)/)
    expect(responsive).toContain('display: block')
  })

  it('堆叠布局：每块面板都有高度上限，内部自己滚', () => {
    // 用户实测报出来的坑：堆叠态里 .col 变成 block，flex:1 失效，
    // 会话列表于是随文件数无限长高、内部滚动条永不出现，还把页面撑到够不着。
    for (const selector of ['.session-list', '.timeline-panel', '.inspector', '.findings-panel']) {
      const pattern = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{[^}]*max-height`)
      expect(responsive, `${selector} 缺少 max-height`).toMatch(pattern)
    }
  })

  it('大屏有内容上限：带鱼屏上不该摊出一行 2734px 的长文', () => {
    expect(layout).toMatch(/max-width:\s*1\d{3}px/)
  })
})
