import { describe, expect, it } from 'vitest'
import { displayWidth, renderHelp, renderSummary } from './summary'
import type { BatchResult } from './batch'

function result(overrides: Partial<BatchResult> = {}): BatchResult {
  return {
    files: [
      { file: 'examples/a.json', sessions: 1, score: 100, grade: 'A' },
      { file: 'examples/b.json', sessions: 2, score: 54, grade: 'D' },
    ],
    entries: [
      { trajectory: { label: 'a' }, card: { overall: 100 } },
      { trajectory: { label: 'b' }, card: { overall: 54 } },
      { trajectory: { label: 'c' }, card: { overall: 54 } },
    ] as unknown as BatchResult['entries'],
    markdown: '# md',
    json: '{}',
    html: '<!doctype html>',
    average: 69,
    worst: { file: 'examples/b.json', label: 'b', score: 54, grade: 'D' },
    gate: null,
    failedFiles: 0,
    semantic: null,
    elapsedMs: 12,
    ...overrides,
  }
}

describe('displayWidth', () => {
  it('counts CJK as two columns', () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('文件')).toBe(4)
    expect(displayWidth('a文')).toBe(3)
    expect(displayWidth('·')).toBe(1)
  })
})

describe('renderSummary', () => {
  it('prints a summary line and an aligned table', () => {
    const text = renderSummary(result(), 'zh-CN')
    const lines = text.split('\n')
    expect(lines[0]).toBe('2 个文件 · 3 个会话 · 平均 69 · 耗时 12ms')
    expect(lines[1]).toContain('文件')
    expect(lines[2]).toContain('examples/a.json')
    // 对齐的不变式：表头与每一行的显示宽度相等（CJK 按两列计）。
    const widths = lines.slice(1, 4).map(displayWidth)
    expect(new Set(widths).size).toBe(1)
  })

  it('adds the worst line and gate verdict', () => {
    const text = renderSummary(
      result({
        gate: { threshold: 90, passed: false, offenders: [{ file: 'b.json', label: 'b', score: 54 }] },
      }),
      'zh-CN',
    )
    expect(text).toContain('最差：examples/b.json · 54 / D')
    expect(text).toContain('门禁：任一低于 90 判失败 → 未通过（1 个会话）')
    expect(text).toContain('· b 54')
  })

  it('reports a passing gate', () => {
    const text = renderSummary(result({ gate: { threshold: 40, passed: true, offenders: [] } }), 'zh-CN')
    expect(text).toContain('通过')
    expect(text).not.toContain('未通过')
  })

  it('counts failed files and prints their reason', () => {
    const text = renderSummary(
      result({
        files: [
          { file: 'ok.json', sessions: 1, score: 100, grade: 'A' },
          {
            file: 'bad.json',
            sessions: 0,
            score: 0,
            grade: '—',
            error: { code: 'invalid-json', message: '不是 JSON' },
          },
        ],
        failedFiles: 1,
      }),
      'zh-CN',
    )
    expect(text).toContain('1 个文件无法分析')
    expect(text).toContain('bad.json')
    expect(text).toContain('不是合法的 JSON')
  })

  it('drops the table in quiet mode', () => {
    const text = renderSummary(result(), 'zh-CN', { quiet: true })
    expect(text.split('\n')).toHaveLength(1)
    expect(text).not.toContain('examples/a.json')
  })

  it('renders in English on request', () => {
    const text = renderSummary(result(), 'en')
    expect(text.startsWith('2 files · 3 sessions · average 69 · 12ms')).toBe(true)
    expect(text).toContain('File')
    expect(text).toContain('Worst:')
  })
})

describe('renderHelp', () => {
  it('lists every option, exit code and an example', () => {
    const text = renderHelp('zh-CN', { version: '0.1.0' })
    for (const flag of [
      '--format',
      '--out',
      '--locale',
      '--pack',
      '--fail-below',
      '--max-files',
      '--max-bytes',
      '--quiet',
      '--help',
    ]) {
      expect(text).toContain(flag)
    }
    expect(text).toContain('0  通过')
    expect(text).toContain('1  质量门禁未通过')
    expect(text).toContain('2  用法错误')
    expect(text).toContain('trajectory-qa ./traces --fail-below 80')
  })

  it('renders in English on request', () => {
    const text = renderHelp('en', { version: '0.1.0' })
    expect(text).toContain('Usage:')
    expect(text).toContain('Exit codes')
  })
})
