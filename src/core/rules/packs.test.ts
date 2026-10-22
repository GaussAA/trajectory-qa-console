/** 双语规则包的结构等价性。
 *
 *  规则包是数据，翻译只应改「说的话」，不能改「怎么判」。这个测试把两件事钉住：
 *  1. 结构与判定完全一致（id、维度、严重度、扣分、表达式、顺序）；
 *  2. 占位符一致——漏一个 `{step}` 不会让报告错乱，却会让结论少掉关键定位。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyze } from '../analysis'
import { DEFAULT_PACK } from './builtin-pack'
import { BUILTIN_PACK_EN } from './builtin-pack-en'
import { validatePack } from './contract'
import { runRules } from './engine'

const EXAMPLE_FILES = ['examples/healthy.json', 'examples/tool-failure.json', 'examples/dead-loop.jsonl']

const CJK = /[\u4e00-\u9fff]/

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort()
}

describe('builtin packs', () => {
  it('both validate against the pack contract', () => {
    expect(validatePack(DEFAULT_PACK).ok).toBe(true)
    expect(validatePack(BUILTIN_PACK_EN).ok).toBe(true)
  })

  it('share dimension ids, weights and colors', () => {
    expect(BUILTIN_PACK_EN.dimensions.map((dimension) => dimension.id)).toEqual(
      DEFAULT_PACK.dimensions.map((dimension) => dimension.id),
    )
    for (const [index, dimension] of BUILTIN_PACK_EN.dimensions.entries()) {
      const zh = DEFAULT_PACK.dimensions[index]
      expect(dimension.weight).toBe(zh?.weight)
      expect(dimension.color).toBe(zh?.color)
      expect(dimension.label).not.toBe(zh?.label)
    }
  })

  it('describe the same rules in the same order with the same judgement', () => {
    expect(BUILTIN_PACK_EN.rules).toHaveLength(DEFAULT_PACK.rules.length)
    for (const [index, rule] of BUILTIN_PACK_EN.rules.entries()) {
      const zh = DEFAULT_PACK.rules[index]
      expect(rule.id).toBe(zh?.id)
      expect(rule.dimension).toBe(zh?.dimension)
      expect(rule.severity).toBe(zh?.severity)
      expect(rule.scoreImpact).toBe(zh?.scoreImpact)
      expect(rule.scope).toBe(zh?.scope)
      expect(rule.expr).toBe(zh?.expr)
      expect(rule.enabled).toBe(zh?.enabled)
      // 文案必须真的翻过，而不是原样复制
      expect(rule.title).not.toBe(zh?.title)
      expect(rule.message).not.toBe(zh?.message)
    }
  })

  it('keeps placeholders identical between languages', () => {
    for (const [index, rule] of BUILTIN_PACK_EN.rules.entries()) {
      const zh = DEFAULT_PACK.rules[index]
      expect(placeholders(rule.message)).toEqual(placeholders(zh?.message ?? ''))
    }
  })

  it('is actually English, while the default pack is Chinese', () => {
    for (const rule of BUILTIN_PACK_EN.rules) {
      expect(rule.title).not.toMatch(CJK)
      expect(rule.message).not.toMatch(CJK)
    }
    for (const dimension of BUILTIN_PACK_EN.dimensions) {
      expect(dimension.label).not.toMatch(CJK)
      expect(dimension.description ?? '').not.toMatch(CJK)
    }
    expect(BUILTIN_PACK_EN.name).not.toMatch(CJK)
    expect(DEFAULT_PACK.rules.every((rule) => CJK.test(rule.title))).toBe(true)
  })

  it('produces identical findings on the example traces', () => {
    for (const file of EXAMPLE_FILES) {
      const source = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8')
      const analyzed = analyze({ source, label: file, pack: DEFAULT_PACK })
      if (!analyzed.ok) throw new Error(`${file}: ${analyzed.error.message}`)

      for (const session of analyzed.value) {
        const english = runRules(session.trajectory, BUILTIN_PACK_EN).findings.map((finding) => ({
          ruleId: finding.ruleId,
          severity: finding.severity,
          stepIndex: finding.stepIndex,
        }))
        const chinese = runRules(session.trajectory, DEFAULT_PACK).findings.map((finding) => ({
          ruleId: finding.ruleId,
          severity: finding.severity,
          stepIndex: finding.stepIndex,
        }))
        expect(english).toEqual(chinese)
      }
    }
  })
})
