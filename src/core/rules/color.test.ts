/** 维度颜色会被写进内联 `background`。`url(…)` 作为颜色，浏览器渲染时会去取那个地址——
 *  导入一份规则包就能让页面向外发请求。这里锁两件事：真实会用的写法全放行，
 *  能触发取资源或引用外部值的写法全拦下。 */

import { describe, expect, it } from 'vitest'
import type { RulePack } from '../model'
import { DEFAULT_PACK } from './builtin-pack'
import { isSafeCssColor, validatePack } from './contract'

function packWithColor(color: string): RulePack {
  return {
    ...DEFAULT_PACK,
    dimensions: DEFAULT_PACK.dimensions.map((dimension, index) =>
      index === 0 ? { ...dimension, color } : dimension,
    ),
  }
}

describe('isSafeCssColor', () => {
  it.each([
    '#fff',
    '#FFF',
    '#ffff',
    '#60a5fa',
    '#60A5FA',
    '#60a5fa80',
    'rgb(96, 165, 250)',
    'rgb(96 165 250)',
    'rgba(96, 165, 250, 0.5)',
    'rgb(96 165 250 / 50%)',
    'hsl(217, 91%, 60%)',
    'hsl(217deg 91% 60%)',
    'hsla(217, 91%, 60%, .5)',
    '  #60a5fa  ',
  ])('accepts %j', (color) => {
    expect(isSafeCssColor(color)).toBe(true)
  })

  it.each([
    ['a remote url', 'url(http://attacker.example/p.png)'],
    ['a quoted url', 'url("https://attacker.example/p.png")'],
    ['a data url', 'url(data:image/svg+xml;base64,AAAA)'],
    ['an image-set', 'image-set("https://attacker.example/p.png" 1x)'],
    ['a css variable', 'var(--anything)'],
    ['calc', 'calc(1px + 2px)'],
    ['an expression()', 'expression(alert(1))'],
    ['a gradient', 'linear-gradient(red, blue)'],
    ['a url hidden after a valid colour', '#fff url(http://attacker.example/p.png)'],
    ['a second declaration smuggled in', '#fff; background-image: url(http://attacker.example/p.png)'],
    ['a url inside rgb()', 'rgb(url(http://attacker.example/p.png))'],
    ['letters inside rgb()', 'rgb(var(--x), 0, 0)'],
    ['a named colour (deliberately not allowed)', 'red'],
    ['a bad hex length', '#12345'],
    ['a hex with non-hex digits', '#ggg'],
    ['an empty-looking string', '   '],
    ['an overlong string', `rgb(${'1,'.repeat(40)}1)`],
  ])('rejects %s', (_name, color) => {
    expect(isSafeCssColor(color)).toBe(false)
  })

  it('stays fast on a hostile input just under the length cap', () => {
    const started = performance.now()
    isSafeCssColor(`rgb(${'1'.repeat(56)}x`)
    expect(performance.now() - started).toBeLessThan(50)
  })
})

describe('validatePack and the dimension colour', () => {
  it('still accepts the built-in pack', () => {
    expect(validatePack(DEFAULT_PACK).ok).toBe(true)
  })

  it('rejects a pack whose colour would make the page fetch a remote url, and says where', () => {
    const result = validatePack(packWithColor('url(http://attacker.example/p.png)'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((error) => error.path === 'dimensions.0.color')).toBe(true)
  })
})
