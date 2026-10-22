import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { displayPath, runBatch } from './batch'

const roots: string[] = []

function tempFile(name: string, content: string): string {
  if (roots.length === 0) roots.push(mkdtempSync(join(tmpdir(), 'tqa-batch-')))
  const path = join(roots[roots.length - 1] as string, name)
  writeFileSync(path, content)
  return path
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const CLEAN = JSON.stringify([
  { role: 'user', content: '查一下报销标准' },
  { role: 'assistant', content: '住宿上限 500 元。' },
])

const BROKEN = JSON.stringify([
  { role: 'user', content: '改工单' },
  { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'update', arguments: '{"id":' } }] },
])

const options = {
  locale: 'zh-CN' as const,
  pack: DEFAULT_PACK,
  failBelow: null,
  maxFileBytes: 1024 * 1024,
}

describe('runBatch', () => {
  it('summarizes files, sessions and the average', () => {
    const clean = tempFile('clean.json', CLEAN)
    const broken = tempFile('broken.json', BROKEN)

    const result = runBatch([clean, broken], options)
    expect(result.files).toHaveLength(2)
    expect(result.entries).toHaveLength(2)
    expect(result.failedFiles).toBe(0)
    expect(result.average).toBeGreaterThan(0)
    expect(result.worst).not.toBeNull()
    expect(result.worst?.score).toBe(Math.min(...result.entries.map((entry) => entry.card.overall)))
    expect(result.markdown).toContain('# 轨迹质检报告')
    expect(JSON.parse(result.json).sessions).toHaveLength(2)
  })

  it('keeps going when one file cannot be parsed', () => {
    const good = tempFile('good.json', CLEAN)
    const bad = tempFile('bad.json', '{not json')

    const result = runBatch([good, bad], options)
    expect(result.files.map((file) => file.error?.code)).toEqual([undefined, 'invalid-json'])
    expect(result.failedFiles).toBe(1)
    expect(result.entries).toHaveLength(1)
  })

  it('marks an oversized file instead of reading it', () => {
    const big = tempFile('big.json', CLEAN)
    const result = runBatch([big], { ...options, maxFileBytes: 10 })
    expect(result.files[0]?.error?.code).toBe('too-large')
    expect(result.entries).toHaveLength(0)
  })

  it('fails the gate on any session below the threshold', () => {
    const clean = tempFile('clean.json', CLEAN)
    const broken = tempFile('broken.json', BROKEN)

    const passed = runBatch([clean], { ...options, failBelow: 50 })
    expect(passed.gate).toEqual({ threshold: 50, passed: true, offenders: [] })

    const failed = runBatch([clean, broken], { ...options, failBelow: 90 })
    expect(failed.gate?.passed).toBe(false)
    expect(failed.gate?.offenders.length).toBeGreaterThan(0)
    expect(failed.gate?.offenders[0]?.score).toBeLessThan(90)
  })

  it('leaves the gate off when no threshold is given', () => {
    const clean = tempFile('clean.json', CLEAN)
    expect(runBatch([clean], options).gate).toBeNull()
  })

  it('honours the locale in both formats', () => {
    const clean = tempFile('clean.json', CLEAN)
    const result = runBatch([clean], { ...options, locale: 'en' })
    expect(result.markdown.startsWith('# Trajectory QA Report')).toBe(true)
    expect(JSON.parse(result.json).locale).toBe('en')
  })
})

describe('displayPath', () => {
  it('uses a unix separator so reports compare across platforms', () => {
    const root = mkdtempSync(join(tmpdir(), 'tqa-path-'))
    roots.push(root)
    const nested = join(root, 'nested', 'a.json')
    expect(displayPath(nested, root)).toBe('nested/a.json')
  })

  it('falls back to the file name outside the working directory', () => {
    expect(displayPath(join(tmpdir(), 'elsewhere', 'a.json'), join(process.cwd(), 'src'))).toBe('a.json')
  })
})
