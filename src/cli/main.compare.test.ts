/** CLI 的 --compare 模式：对比报告、门禁只看对照、打印的结论与退出码一致。 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT, main } from './main'
import { BROKEN, CLEAN, capture, cleanupTempDirs, tempDir, trace } from './test-support'

afterEach(cleanupTempDirs)

describe('compare mode', () => {
  it('writes a comparison report for exactly two traces', async () => {
    const dir = tempDir()
    trace(dir, 'a.json', CLEAN)
    trace(dir, 'b.json', BROKEN)
    const out = join(dir, 'out')
    const { io, chunks } = capture()

    const code = await main([dir, '--compare', '--out', out], io)

    expect(code).toBe(EXIT.ok)
    expect(chunks.out).toContain('对比：')
    expect(existsSync(join(out, 'compare.md'))).toBe(true)
    expect(existsSync(join(out, 'compare.json'))).toBe(true)
    // 对比模式不额外产出逐会话报告，避免两份文件语义重叠
    expect(existsSync(join(out, 'report.md'))).toBe(false)
    expect(readFileSync(join(out, 'compare.md'), 'utf8')).toContain('# 轨迹对比报告')
  })

  it('refuses to compare fewer than two traces', async () => {
    const dir = tempDir()
    trace(dir, 'a.json', CLEAN)
    const { io, chunks } = capture()

    expect(await main([dir, '--compare'], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('恰好两条')
  })

  it('gates only the candidate, not the baseline', async () => {
    const dir = tempDir()
    trace(dir, 'a.json', CLEAN)
    trace(dir, 'b.json', BROKEN)

    // 基准 100、对照 54：门限 80 只该判「对照」不合格。
    const { io } = capture()
    expect(await main([dir, '--compare', '--fail-below', '80', '--quiet'], io)).toBe(EXIT.gate)

    const relaxed = capture()
    expect(await main([dir, '--compare', '--fail-below', '10', '--quiet'], relaxed.io)).toBe(EXIT.ok)
  })
})

describe('compare mode: the printed verdict and the exit code agree', () => {
  it('does not print a failing gate for the baseline when the candidate passes', async () => {
    const dir = tempDir()
    // 基准是坏的（54），对照是好的（100）：对照达标，整体应当「通过」，退出码 0。
    trace(dir, 'a.json', BROKEN)
    trace(dir, 'b.json', CLEAN)
    const { io, chunks } = capture()

    const code = await main([dir, '--compare', '--fail-below', '80'], io)

    expect(code).toBe(EXIT.ok)
    // 之前的门禁行统计了所有会话（含基准），会印出「未通过」而退出码却是 0。
    expect(chunks.out).not.toContain('未通过')
    expect(chunks.out).toContain('通过')
  })

  it('prints a failing gate naming only the candidate when the candidate fails', async () => {
    const dir = tempDir()
    trace(dir, 'a.json', CLEAN)
    trace(dir, 'b.json', BROKEN)
    const { io, chunks } = capture()

    const code = await main([dir, '--compare', '--fail-below', '80'], io)

    expect(code).toBe(EXIT.gate)
    expect(chunks.out).toContain('未通过（1 个会话）')
    // 只点对照的名字，基准（达标）不该出现在违规清单里
    expect(chunks.out).toMatch(/· b\.json/)
    expect(chunks.out).not.toMatch(/· a\.json/)
  })
})
