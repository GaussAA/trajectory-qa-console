/** 对比两条轨迹的「问题变化」。
 *
 *  此前的键是 `规则#步号#消息文案`，两处都是漂的：
 *  - 步号是各自轨迹里的原始下标：改 prompt 后中间多出一步，后面所有逐步问题的步号都 +1，
 *    于是每一条都显示成「已修复 + 新增」，净变化为 0，却列出一长串假的增删；
 *  - 消息文案里嵌着步号和计数（「第 7 步…」「连续 9 次」），步号一变、计数一变，键又不同了。
 *  现在用对齐结果把基准的步号换算到对照的步号，再按「规则 + 对齐后的步」认同一条问题；
 *  文案不进键，变了的单独列出来，而不是当成一条消失、一条出现。 */

import { describe, expect, it } from 'vitest'
import { alignSteps, diffFindings } from './sessions'
import type { Finding, Step } from '../model'
import { makeStep as step } from '../test-support'

function finding(
  ruleId: string,
  stepIndex: number | undefined,
  message = `第 ${stepIndex} 步有问题`,
): Finding {
  return {
    id: `${ruleId}-${stepIndex}`,
    ruleId,
    ruleTitle: ruleId,
    dimension: 'structure',
    severity: 'warn',
    message,
    stepIndex,
    impact: 5,
  }
}

/** user, assistant(search), tool, assistant(search), tool, assistant —— 结构各不相同，LCS 不会错配。 */
const BASE: Step[] = [
  step(0, 'system', 's'),
  step(1, 'user', 'q'),
  step(2, 'assistant', '', ['search']),
  step(3, 'tool', 'r1'),
  step(4, 'assistant', '', ['write']),
  step(5, 'tool', 'r2'),
  step(6, 'assistant', 'done'),
]

/** 在第 2 步前插入一个新的助手步（调用另一个工具）：原来的第 2 步起全部后移一位。 */
const WITH_INSERT: Step[] = [
  step(0, 'system', 's'),
  step(1, 'user', 'q'),
  step(2, 'assistant', '', ['plan']),
  step(3, 'assistant', '', ['search']),
  step(4, 'tool', 'r1'),
  step(5, 'assistant', '', ['write']),
  step(6, 'tool', 'r2'),
  step(7, 'assistant', 'done'),
]

describe('a step inserted upstream does not turn every later finding into resolved + added', () => {
  const rows = alignSteps(BASE, WITH_INSERT)

  it('the premise: alignment pairs the shifted steps and reports exactly one added step', () => {
    expect(rows.filter((row) => row.status === 'added')).toHaveLength(1)
    expect(rows.filter((row) => row.status === 'removed')).toHaveLength(0)
  })

  it('without alignment (the old behaviour) every shifted finding looks new — this is the bug', () => {
    const before = [finding('r-write', 4), finding('r-tool', 5)]
    const after = [finding('r-write', 5), finding('r-tool', 6)]
    const naive = diffFindings(before, after)
    expect(naive.added).toHaveLength(2)
    expect(naive.resolved).toHaveLength(2)
  })

  it('with alignment the same problems are recognised as the same problems', () => {
    const before = [finding('r-write', 4), finding('r-tool', 5)]
    const after = [finding('r-write', 5), finding('r-tool', 6)]
    const diff = diffFindings(before, after, rows)
    expect(diff.added).toEqual([])
    expect(diff.resolved).toEqual([])
    expect(diff.persisted.map((item) => item.ruleId)).toEqual(['r-write', 'r-tool'])
    expect(diff.netChange).toBe(0)
  })

  it('a finding on the inserted step itself is genuinely new', () => {
    const before = [finding('r-write', 4)]
    const after = [finding('r-write', 5), finding('r-plan', 2)]
    const diff = diffFindings(before, after, rows)
    expect(diff.added.map((item) => item.ruleId)).toEqual(['r-plan'])
    expect(diff.resolved).toEqual([])
  })

  it('a problem that is really fixed still shows as resolved', () => {
    const before = [finding('r-write', 4), finding('r-tool', 5)]
    const after = [finding('r-tool', 6)]
    const diff = diffFindings(before, after, rows)
    expect(diff.resolved.map((item) => item.ruleId)).toEqual(['r-write'])
    expect(diff.added).toEqual([])
  })
})

describe('a step removed upstream', () => {
  const rows = alignSteps(WITH_INSERT, BASE)

  it('keeps the surviving problems and reports the ones on the removed step as resolved', () => {
    const before = [finding('r-plan', 2), finding('r-write', 5)]
    const after = [finding('r-write', 4)]
    const diff = diffFindings(before, after, rows)
    expect(diff.persisted.map((item) => item.ruleId)).toEqual(['r-write'])
    // 那一步本身没了，它上面的问题随之消失：算修复，而不是悄悄不见
    expect(diff.resolved.map((item) => item.ruleId)).toEqual(['r-plan'])
    expect(diff.added).toEqual([])
  })
})

describe('a problem on a removed step must not be matched to an unrelated step by number', () => {
  // 基准的第 1 步（工具 gone）在对照里被删了，对照只有 3 步。基准在那一步上有 rule-x 的问题；
  // 对照里另一步（它的第 1 步，工具 keep）上也恰好有 rule-x。两者原始步号都是 1，但根本不是同一个问题。
  const base = [
    step(0, 'user', 'q'),
    step(1, 'assistant', '', ['gone']),
    step(2, 'assistant', '', ['keep']),
    step(3, 'assistant', 'end'),
  ]
  const target = [step(0, 'user', 'q'), step(1, 'assistant', '', ['keep']), step(2, 'assistant', 'end')]
  const rows = alignSteps(base, target)

  it('the premise: the gone step has no partner in the target', () => {
    expect(rows.filter((row) => row.status === 'removed').map((row) => row.before?.index)).toEqual([1])
  })

  it('reports the old one as resolved and the other as new, instead of calling them the same', () => {
    const diff = diffFindings([finding('rule-x', 1)], [finding('rule-x', 1)], rows)
    expect(diff.resolved).toHaveLength(1)
    expect(diff.added).toHaveLength(1)
    expect(diff.persisted).toEqual([])
  })
})

describe('the message is not part of the identity', () => {
  it('a counter that moved is the same problem, listed as changed rather than gone-and-new', () => {
    const rows = alignSteps(BASE, BASE)
    const before = [finding('dead-loop', undefined, '同一工具调用连续重复 9 次')]
    const after = [finding('dead-loop', undefined, '同一工具调用连续重复 12 次')]
    const diff = diffFindings(before, after, rows)
    expect(diff.added).toEqual([])
    expect(diff.resolved).toEqual([])
    expect(diff.persisted).toHaveLength(1)
    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0]?.before.message).toContain('9 次')
    expect(diff.changed[0]?.after.message).toContain('12 次')
  })

  it('a step number inside the text that merely shifted is not a change worth listing', () => {
    // 插入一步后「第 4 步」变成「第 5 步」：问题没变，只是步号跟着挪了
    const rows = alignSteps(BASE, WITH_INSERT)
    const diff = diffFindings(
      [finding('r-write', 4, '第 5 步没有结果')],
      [finding('r-write', 5, '第 6 步没有结果')],
      rows,
    )
    expect(diff.persisted).toHaveLength(1)
    expect(diff.changed).toEqual([])
  })

  it('identical findings are persisted and not changed', () => {
    const rows = alignSteps(BASE, BASE)
    const diff = diffFindings([finding('a', 2, 'm')], [finding('a', 2, 'm')], rows)
    expect(diff.persisted).toHaveLength(1)
    expect(diff.changed).toEqual([])
  })
})

describe('what must keep working', () => {
  it('without rows it falls back to comparing raw step numbers, as before', () => {
    const diff = diffFindings([finding('a', 1)], [finding('a', 2)])
    expect(diff.added).toHaveLength(1)
    expect(diff.resolved).toHaveLength(1)
  })

  it('trajectory-level findings never depend on alignment', () => {
    const rows = alignSteps(BASE, WITH_INSERT)
    const diff = diffFindings([finding('long', undefined, 'm')], [finding('long', undefined, 'm')], rows)
    expect(diff.persisted).toHaveLength(1)
    expect(diff.added).toEqual([])
  })

  it('a finding whose step index is outside the trajectory does not crash the diff', () => {
    const rows = alignSteps(BASE, BASE)
    expect(() => diffFindings([finding('a', 99)], [finding('a', 98)], rows)).not.toThrow()
  })

  it('works when the alignment fell back to positional pairing for a huge trace', () => {
    // 超过单元格上限时对齐退化为按位置配对：行里照样是 before/after 成对，换算依然成立
    const rows = alignSteps(BASE, BASE, 1)
    const diff = diffFindings([finding('a', 3)], [finding('a', 3)], rows)
    expect(diff.persisted).toHaveLength(1)
  })

  it('counts net change from added and resolved only, not from changed', () => {
    const rows = alignSteps(BASE, BASE)
    const diff = diffFindings(
      [finding('x', undefined, '9 次'), finding('gone', 2)],
      [finding('x', undefined, '12 次'), finding('new', 3)],
      rows,
    )
    expect(diff.netChange).toBe(0)
    expect(diff.changed).toHaveLength(1)
  })
})
