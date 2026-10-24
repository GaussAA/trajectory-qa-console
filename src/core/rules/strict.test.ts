/** 规则包校验此前对两类错误视而不见：
 *  - 多余的键被 zod 悄悄丢掉：写成 `enable: false`（少了个 d）的规则照样启用，没有任何提示；
 *  - 消息里的 `{占位符}` 不检查：写错名字，渲染时原样留着 `{stepp}`，用户在报告里才看到。
 *  这两种都是「导入成功、行为不对」，最难排查。 */

import { describe, expect, it } from 'vitest'
import { createMemoryStorage, createPersistence } from '../../app/persistence'
import type { Rule, RulePack } from '../model'
import { DEFAULT_PACK } from './builtin-pack'
import { BUILTIN_PACK_EN } from './builtin-pack-en'
import { validatePack } from './contract'

/** 造一份包，改其中一条规则；`extra` 是塞进去的非法键。 */
function withRule(patch: Partial<Rule> & Record<string, unknown>): unknown {
  const [first, ...rest] = DEFAULT_PACK.rules
  return { ...DEFAULT_PACK, rules: [{ ...first, ...patch }, ...rest] }
}

function errorsOf(input: unknown) {
  const result = validatePack(input)
  return result.ok ? [] : result.errors
}

describe('unknown keys are errors, not silently dropped', () => {
  it('still accepts the shipped packs, so strictness costs nothing there', () => {
    expect(validatePack(DEFAULT_PACK).ok).toBe(true)
    expect(validatePack(BUILTIN_PACK_EN).ok).toBe(true)
  })

  it('rejects a misspelt rule key and points at it, with a hint', () => {
    // 少了个 d：以前这条规则照样启用
    const errors = errorsOf(withRule({ enable: false }))
    const hit = errors.find((error) => error.path === 'rules.0')
    expect(hit).toBeDefined()
    expect(hit?.message).toContain('enable')
    expect(hit?.message).toContain('enabled')
  })

  it('rejects a stray key on a dimension', () => {
    const dimensions = DEFAULT_PACK.dimensions.map((d, i) => (i === 0 ? { ...d, colour: '#fff' } : d))
    const errors = errorsOf({ ...DEFAULT_PACK, dimensions })
    expect(errors.some((error) => error.path === 'dimensions.0' && error.message.includes('colour'))).toBe(true)
  })

  it('rejects a stray key at the top level', () => {
    const errors = errorsOf({ ...DEFAULT_PACK, descripton: 'x' })
    expect(errors.some((error) => error.path === '(root)' && error.message.includes('descripton'))).toBe(true)
  })

  it('reports every unknown key, not only the first', () => {
    const errors = errorsOf(withRule({ enable: false, scoreImpct: 3 }))
    const text = errors.map((error) => error.message).join(' ')
    expect(text).toContain('enable')
    expect(text).toContain('scoreImpct')
  })

  it('does not suggest anything wildly unrelated for a key that is just wrong', () => {
    const errors = errorsOf(withRule({ completelyDifferent: 1 }))
    const hit = errors.find((error) => error.path === 'rules.0')
    expect(hit?.message).toContain('completelyDifferent')
    expect(hit?.message).not.toMatch(/是否指/)
  })

  it('keeps accepting the optional fields that have defaults', () => {
    const { enabled: _enabled, builtin: _builtin, ...bare } = DEFAULT_PACK.rules[0] as Rule
    expect(validatePack({ ...DEFAULT_PACK, rules: [bare, ...DEFAULT_PACK.rules.slice(1)] }).ok).toBe(true)
  })
})

describe('message placeholders must name a field the rule can actually fill', () => {
  it('accepts every placeholder the shipped rules use', () => {
    // 28 处：内置规则本来就合法，校验不能把它们也挡了
    expect(validatePack(DEFAULT_PACK).ok).toBe(true)
  })

  it('rejects a misspelt placeholder and suggests the right one', () => {
    const errors = errorsOf(withRule({ scope: 'step', message: '第 {stepp} 步有问题' }))
    const hit = errors.find((error) => error.path === 'rules.0.message')
    expect(hit?.message).toContain('stepp')
    expect(hit?.message).toContain('step')
  })

  it('rejects a trajectory-scope rule that asks for a step-only field', () => {
    // `step` 只在逐步规则里有；整条轨迹的规则渲染时拿不到，会原样留着 {step}
    const errors = errorsOf(
      withRule({ scope: 'trajectory', expr: 'stepCount > 1', message: '问题出在第 {step} 步' }),
    )
    expect(errors.some((error) => error.path === 'rules.0.message' && error.message.includes('step'))).toBe(true)
  })

  it('rejects a step-scope rule that asks for a trajectory-only field', () => {
    const errors = errorsOf(withRule({ scope: 'step', expr: 'role == "tool"', message: '共 {stepCount} 步' }))
    expect(errors.some((error) => error.path === 'rules.0.message' && error.message.includes('stepCount'))).toBe(true)
  })

  it('accepts a trajectory rule using trajectory fields and a step rule using step fields', () => {
    expect(validatePack(withRule({ scope: 'trajectory', expr: 'stepCount > 1', message: '共 {stepCount} 步' })).ok).toBe(true)
    expect(validatePack(withRule({ scope: 'step', expr: 'role == "tool"', message: '第 {step} 步，{role}' })).ok).toBe(true)
  })

  it('reports each bad placeholder once per rule, even if it repeats', () => {
    const errors = errorsOf(withRule({ message: '{nope} {nope} {nope}' })).filter((error) => error.path === 'rules.0.message')
    expect(errors).toHaveLength(1)
  })

  it('reports different bad placeholders of one rule together', () => {
    const errors = errorsOf(withRule({ message: '{aaa} 与 {bbb}' })).filter((error) => error.path === 'rules.0.message')
    const text = errors.map((error) => error.message).join(' ')
    expect(text).toContain('aaa')
    expect(text).toContain('bbb')
  })

  it('leaves braces that are not placeholders alone', () => {
    // renderMessage 只替换 {单词}；其余的花括号按字面输出，不该被当成占位符
    for (const message of ['集合 {} 为空', 'JSON 形如 {"a": 1}', '单个 { 或 } 都行', '{ step }']) {
      expect(validatePack(withRule({ message })).ok, message).toBe(true)
    }
  })

  it('treats {1} as a placeholder attempt, exactly as the renderer would', () => {
    // renderMessage 的正则是 \{(\w+)\}，\w 包含数字：{1} 渲染时会去找名为 1 的字段，找不到就原样留着。
    expect(errorsOf(withRule({ message: '第 {1} 步' })).some((error) => error.path === 'rules.0.message')).toBe(true)
  })

  it('still checks the expression, as before', () => {
    const errors = errorsOf(withRule({ expr: 'nonexistentField > 1' }))
    expect(errors.some((error) => error.path === 'rules.0.expr')).toBe(true)
  })
})

describe('stored data written before this check', () => {
  it('a stored pack with a stray key falls back to the default instead of loading half-understood', () => {
    const storage = createMemoryStorage()
    storage.setItem('tqa.pack', JSON.stringify({ schemaVersion: 1, data: withRule({ enable: false }) }))
    expect(createPersistence(storage).loadPack()).toEqual(DEFAULT_PACK)
  })

  it('a stored variant with a bad placeholder is dropped, clean ones kept', () => {
    const storage = createMemoryStorage()
    const variant = (id: string, pack: unknown) => ({ id, name: id, savedAt: '2026-10-24T00:00:00Z', pack })
    storage.setItem(
      'tqa.pack-variants',
      JSON.stringify({
        schemaVersion: 1,
        data: [variant('bad', withRule({ message: '{stepp}' })), variant('good', DEFAULT_PACK as RulePack)],
      }),
    )
    expect(createPersistence(storage).loadPackVariants().map((item) => item.id)).toEqual(['good'])
  })
})
