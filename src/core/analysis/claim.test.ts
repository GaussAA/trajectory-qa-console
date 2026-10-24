/** `sem-unverified-claim` used to read Chinese only, so the English pack carried a rule
 *  that could never fire on an English trace. These tests pin both languages and, just as
 *  important, the phrases that must NOT count as a claim. */

import { describe, expect, it } from 'vitest'
import { CLAIM_PATTERN } from './metrics'
import { analyze, scoreSession } from './index'
import { DEFAULT_PACK } from '../rules/builtin-pack'
import { BUILTIN_PACK_EN } from '../rules/builtin-pack-en'

function claimFindings(messages: unknown[], pack = DEFAULT_PACK) {
  const result = analyze({ source: JSON.stringify(messages), label: 'claim.json', idPrefix: 'claim' })
  if (!result.ok) throw new Error(result.error.message)
  const session = result.value.sessions[0]
  if (!session) throw new Error('expected one session')
  return scoreSession(session, pack).findings.filter((finding) => finding.ruleId === 'sem-unverified-claim')
}

describe('CLAIM_PATTERN', () => {
  it.each([
    '根据搜索结果，住宿上限 500 元',
    'According to the search results, the limit is 500.',
    'Based on the documentation, you can set it to 3.',
    'The search results show a 20% drop.',
    'The report states that the limit is 500.',
  ])('counts %j as citing an external source', (text) => {
    expect(CLAIM_PATTERN.test(text)).toBe(true)
  })

  it.each([
    '我来帮你想一想',
    'Based on the data I have, I would guess 500.',
    'I read the docs yesterday and it was fine.',
    'Let me search for that.',
    'The results are in the next message.',
  ])('does not count %j', (text) => {
    expect(CLAIM_PATTERN.test(text)).toBe(false)
  })
})

describe('sem-unverified-claim on an English trace', () => {
  const unsupported = [
    { role: 'user', content: 'What is the hotel limit?' },
    { role: 'assistant', content: 'According to the search results, the limit is 500 per night.' },
  ]

  it('fires when the assistant cites a source before making any tool call', () => {
    expect(claimFindings(unsupported)).toHaveLength(1)
  })

  it('fires under the English pack too, since the rule is the same expression', () => {
    expect(claimFindings(unsupported, BUILTIN_PACK_EN)).toHaveLength(1)
  })

  it('stays quiet when a tool was called first', () => {
    const supported = [
      { role: 'user', content: 'What is the hotel limit?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'limit: 500' },
      { role: 'assistant', content: 'According to the search results, the limit is 500 per night.' },
    ]
    expect(claimFindings(supported)).toHaveLength(0)
  })
})
