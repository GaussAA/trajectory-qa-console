import { describe, expect, it } from 'vitest'
import { CLI_DEFAULTS, parseArgs } from './args'

function ok(argv: string[]) {
  const result = parseArgs(argv)
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}`)
  return result.options
}

function failCode(argv: string[]) {
  const result = parseArgs(argv)
  if (result.ok) throw new Error('expected failure')
  return result.error
}

describe('parseArgs', () => {
  it('reads paths and defaults', () => {
    const options = ok(['traces/a.json'])
    expect(options.paths).toEqual(['traces/a.json'])
    expect(options.format).toBe(CLI_DEFAULTS.format)
    expect(options.locale).toBe('zh-CN')
    expect(options.failBelow).toBeNull()
    expect(options.maxFiles).toBe(500)
    expect(options.maxFileBytes).toBe(32 * 1024 * 1024)
  })

  it('accepts both --flag value and --flag=value', () => {
    expect(ok(['a', '--format', 'md']).format).toBe('md')
    expect(ok(['a', '--format=json']).format).toBe('json')
    expect(ok(['a', '--fail-below=85']).failBelow).toBe(85)
  })

  it('collects positional paths across flags', () => {
    const options = ok(['a.json', '--locale', 'en', 'b.jsonl', '--quiet', 'dir'])
    expect(options.paths).toEqual(['a.json', 'b.jsonl', 'dir'])
    expect(options.locale).toBe('en')
    expect(options.quiet).toBe(true)
  })

  it('treats everything after -- as a path', () => {
    expect(ok(['--', '--weird-name.json']).paths).toEqual(['--weird-name.json'])
  })

  it('short-circuits help and version without paths', () => {
    expect(ok(['--help']).help).toBe(true)
    expect(ok(['-v']).version).toBe(true)
  })

  it('rejects unknown flags with the flag name', () => {
    const error = failCode(['a', '--nope'])
    expect(error.code).toBe('unknown-flag')
    expect(error.flag).toBe('--nope')
  })

  it('rejects a flag with no value', () => {
    const error = failCode(['a', '--format'])
    expect(error.code).toBe('missing-value')
    expect(error.flag).toBe('--format')
  })

  it('rejects out-of-range numbers and reports the range', () => {
    const error = failCode(['a', '--fail-below', '101'])
    expect(error.code).toBe('invalid-number')
    expect(error.range).toEqual({ min: 0, max: 100 })

    expect(failCode(['a', '--max-files', '0']).code).toBe('invalid-number')
    expect(failCode(['a', '--max-bytes', '1.5']).code).toBe('invalid-number')
  })

  it('rejects a missing value for value-taking flags', () => {
    for (const flag of ['--out', '--pack', '--max-files', '--max-bytes', '--fail-below']) {
      const error = failCode(['a', flag])
      expect(error.code).toBe('missing-value')
      expect(error.flag).toBe(flag)
    }
  })

  it('accepts explicit numeric bounds', () => {
    expect(ok(['a', '--fail-below', '0']).failBelow).toBe(0)
    expect(ok(['a', '--fail-below', '100']).failBelow).toBe(100)
    expect(ok(['a', '--max-files=1']).maxFiles).toBe(1)
    expect(ok(['a', '--max-bytes', '1024']).maxFileBytes).toBe(1024)
  })

  it('rejects unknown formats and locales', () => {
    expect(failCode(['a', '--format', 'pdf']).code).toBe('invalid-format')
    expect(failCode(['a', '--locale', 'fr']).code).toBe('invalid-locale')
  })

  it('requires at least one path', () => {
    expect(failCode([]).code).toBe('no-paths')
    expect(failCode(['--quiet']).code).toBe('no-paths')
  })
})
