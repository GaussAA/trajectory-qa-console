/** 本地存的规则包若带着恶意颜色、多余的键或写错的占位符，读出来时要回退默认包（或丢掉该变体），
 *  不能带着半懂不懂的内容进工作区。校验本身的用例在 core/rules/color.test.ts 与 strict.test.ts。 */

import { describe, expect, it } from 'vitest'
import type { Rule, RulePack } from '../core/model'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { createMemoryStorage, createPersistence } from './persistence'

const variant = (id: string, pack: unknown) => ({ id, name: id, savedAt: '2026-10-24T00:00:00Z', pack })

function packWithColor(color: string): RulePack {
  return {
    ...DEFAULT_PACK,
    dimensions: DEFAULT_PACK.dimensions.map((dimension, index) =>
      index === 0 ? { ...dimension, color } : dimension,
    ),
  }
}

/** 造一份包，改其中一条规则；`extra` 是塞进去的非法键。 */
function withRule(patch: Partial<Rule> & Record<string, unknown>): unknown {
  const [first, ...rest] = DEFAULT_PACK.rules
  return { ...DEFAULT_PACK, rules: [{ ...first, ...patch }, ...rest] }
}

describe('a stored pack with a hostile colour', () => {
  const hostile = packWithColor('url(http://attacker.example/p.png)')

  it('falls back to the default pack instead of rendering it', () => {
    const storage = createMemoryStorage()
    storage.setItem('tqa.pack', JSON.stringify({ schemaVersion: 1, data: hostile }))
    expect(createPersistence(storage).loadPack()).toEqual(DEFAULT_PACK)
  })

  it('drops a stored variant carrying one, keeping the clean variants', () => {
    const storage = createMemoryStorage()
    storage.setItem(
      'tqa.pack-variants',
      JSON.stringify({ schemaVersion: 1, data: [variant('bad', hostile), variant('good', DEFAULT_PACK)] }),
    )
    expect(
      createPersistence(storage)
        .loadPackVariants()
        .map((item) => item.id),
    ).toEqual(['good'])
  })
})

describe('stored data written before strict validation', () => {
  it('a stored pack with a stray key falls back to the default instead of loading half-understood', () => {
    const storage = createMemoryStorage()
    storage.setItem('tqa.pack', JSON.stringify({ schemaVersion: 1, data: withRule({ enable: false }) }))
    expect(createPersistence(storage).loadPack()).toEqual(DEFAULT_PACK)
  })

  it('a stored variant with a bad placeholder is dropped, clean ones kept', () => {
    const storage = createMemoryStorage()
    storage.setItem(
      'tqa.pack-variants',
      JSON.stringify({
        schemaVersion: 1,
        data: [variant('bad', withRule({ message: '{stepp}' })), variant('good', DEFAULT_PACK)],
      }),
    )
    expect(
      createPersistence(storage)
        .loadPackVariants()
        .map((item) => item.id),
    ).toEqual(['good'])
  })
})
