import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PACK } from '../core/rules/builtin-pack'
import { BUILTIN_PACK_EN } from '../core/rules/builtin-pack-en'
import { EXIT, chatCompletionsUrl, loadPack, main, resolvePackAlias } from './main'
import { CLI_VERSION } from './version'

const roots: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tqa-main-'))
  roots.push(dir)
  return dir
}

function trace(dir: string, name: string, content: string): string {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

const CLEAN = JSON.stringify([
  { role: 'user', content: '查一下报销标准' },
  { role: 'assistant', content: '住宿上限 500 元。' },
])

const BROKEN = JSON.stringify([
  { role: 'user', content: '改工单' },
  { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'update', arguments: '{"id":' } }] },
])

function capture() {
  const chunks: { out: string; err: string } = { out: '', err: '' }
  return {
    chunks,
    io: {
      out: (chunk: string) => {
        chunks.out += chunk
      },
      err: (chunk: string) => {
        chunks.err += chunk
      },
    },
  }
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('main', () => {
  it('prints help and exits 0', async () => {
    const { io, chunks } = capture()
    expect(await main(['--help'], io)).toBe(EXIT.ok)
    expect(chunks.out).toContain('用法：')
  })

  it('prints the version and exits 0', async () => {
    const { io, chunks } = capture()
    expect(await main(['--version'], io)).toBe(EXIT.ok)
    expect(chunks.out.trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('falls back to the real stdout when no io is injected', async () => {
    const written: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })
    try {
      expect(await main(['--version'])).toBe(EXIT.ok)
    } finally {
      spy.mockRestore()
    }
    expect(written.join('')).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('rejects bad usage with exit 2 and a hint', async () => {
    const { io, chunks } = capture()
    expect(await main(['--nope'], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('未知选项')
    expect(chunks.err).toContain('--help')
  })

  it('follows --locale for its own errors', async () => {
    const { io, chunks } = capture()
    expect(await main(['--locale', 'en', '--nope'], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('Unknown option')
  })

  it('reports a missing path', async () => {
    const { io, chunks } = capture()
    expect(await main([join(tempDir(), 'ghost.json')], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('路径不存在')
  })

  it('analyzes a directory and prints the table', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const { io, chunks } = capture()

    expect(await main([dir], io)).toBe(EXIT.ok)
    expect(chunks.out).toContain('1 个文件')
    expect(chunks.out).toContain('A')
    expect(chunks.err).toBe('')
  })

  it('returns 1 when the gate fails, 0 when it passes', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    trace(dir, 'broken.json', BROKEN)

    const failing = capture()
    expect(await main([dir, '--fail-below', '90', '--quiet'], failing.io)).toBe(EXIT.gate)
    expect(failing.chunks.out).toContain('未通过')

    const passing = capture()
    expect(await main([dir, '--fail-below', '10', '--quiet'], passing.io)).toBe(EXIT.ok)
  })

  it('writes the reports with --out and honours --format', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    // 产物目录放在被扫描目录之外：否则上一轮的 report.json 会被当成轨迹
    // 再解析一遍（扩展名相同），这正是「部分失败」要防的自污染。
    const out = tempDir()

    const both = capture()
    expect(await main([dir, '--out', out, '--quiet'], both.io)).toBe(EXIT.ok)
    expect(existsSync(join(out, 'report.md'))).toBe(true)
    expect(existsSync(join(out, 'report.json'))).toBe(true)
    expect(both.chunks.out).toContain('已写出')

    const mdOnly = tempDir()
    expect(await main([dir, '--out', mdOnly, '--format', 'md', '--quiet'], capture().io)).toBe(EXIT.ok)
    expect(existsSync(join(mdOnly, 'report.md'))).toBe(true)
    expect(existsSync(join(mdOnly, 'report.json'))).toBe(false)
  })

  it('writes a single self-contained HTML report with --format html', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    trace(dir, 'broken.json', BROKEN)
    const out = join(dir, 'html-only')
    const { io, chunks } = capture()

    expect(await main([dir, '--out', out, '--format', 'html', '--quiet'], io)).toBe(EXIT.ok)

    expect(existsSync(join(out, 'report.html'))).toBe(true)
    // html 是「只出这一份」，不该顺手再写 md/json
    expect(existsSync(join(out, 'report.md'))).toBe(false)
    expect(existsSync(join(out, 'report.json'))).toBe(false)

    const html = readFileSync(join(out, 'report.html'), 'utf8')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('轨迹质检报告')
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/src=["']https?:/i)
    expect(chunks.out).toContain('report.html')
  })

  it('writes all three artifacts with --format all', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const out = join(dir, 'all')

    expect(await main([dir, '--out', out, '--format', 'all', '--quiet'], capture().io)).toBe(EXIT.ok)
    for (const name of ['report.md', 'report.json', 'report.html']) {
      expect(existsSync(join(out, name))).toBe(true)
    }
  })

  it('compares the active pack against another with --pack-compare', async () => {
    const dir = tempDir()
    trace(dir, 'single.json', CLEAN)
    const out = join(dir, 'pk')
    const { io, chunks } = capture()

    expect(await main([dir, '--pack-compare', 'en', '--out', out, '--quiet'], io)).toBe(EXIT.ok)

    expect(existsSync(join(out, 'pack-compare.md'))).toBe(true)
    expect(existsSync(join(out, 'pack-compare.json'))).toBe(true)
    const markdown = readFileSync(join(out, 'pack-compare.md'), 'utf8')
    expect(markdown).toContain('# 口径对比报告')
    expect(markdown).toContain('| 会话 | 基准 | 对照 | 变化 |')
    expect(chunks.out).toContain('口径对比：')
  })

  it('rejects combining --pack-compare with --compare', async () => {
    const dir = tempDir()
    trace(dir, 'a.json', CLEAN)
    const { io, chunks } = capture()

    expect(await main([dir, '--compare', '--pack-compare', 'en'], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('不能同时使用')
  })

  it('rejects conflicting modes before spending any LLM budget', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const calls: unknown[] = []
    const { io, chunks } = capture()

    // The conflict used to be reported only after runBatch had already called
    // the model — the user paid for their own usage error.
    const code = await main(
      [
        dir,
        '--compare',
        '--pack-compare',
        'en',
        '--semantic',
        '--llm-url',
        'https://llm.example/v1',
        '--llm-model',
        'm',
      ],
      io,
      {
        env: { TQA_LLM_API_KEY: 'k-123' },
        transport: async (request) => {
          calls.push(request)
          // 内容无关紧要：这个用例断言的是它根本不该被调用。
          return { ok: true, status: 200, text: '{}' }
        },
      },
    )

    expect(code).toBe(EXIT.error)
    expect(chunks.err).toContain('不能同时使用')
    expect(calls).toHaveLength(0)
  })

  it('writes an HTML comparison with --compare --format html', async () => {
    const dir = tempDir()
    trace(dir, 'a.json', CLEAN)
    trace(dir, 'b.json', BROKEN)
    const out = join(dir, 'cmp-html')
    const { io, chunks } = capture()

    expect(await main([dir, '--compare', '--format', 'html', '--out', out, '--quiet'], io)).toBe(EXIT.ok)

    expect(existsSync(join(out, 'compare.html'))).toBe(true)
    expect(existsSync(join(out, 'compare.md'))).toBe(false)
    const html = readFileSync(join(out, 'compare.html'), 'utf8')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('轨迹对比报告')
    expect(html).not.toMatch(/<script/i)
    expect(chunks.out).toContain('compare.html')
  })

  it('exits 2 when the output directory cannot be created', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    // 把 --out 指向一个已存在的文件，mkdir 必然失败。放在扫描目录之外，
    // 免得它自己先被当成轨迹解析失败，把写入错误盖掉。
    const blocker = trace(tempDir(), 'blocker.txt', 'x')
    const { io, chunks } = capture()

    expect(await main([dir, '--out', blocker, '--quiet'], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('写入')
  })

  it('refuses to report success when every file failed', async () => {
    const dir = tempDir()
    trace(dir, 'bad.json', '{not json')
    const { io, chunks } = capture()

    // 「什么都没分析到」必须是 2：空跑通过比失败更危险。
    expect(await main([dir], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('未产出报告')
  })

  it('refuses to pass the gate when only some files could be analysed', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    trace(dir, 'broken.json', '{not json')
    const { io, chunks } = capture()

    // 有一条成功也不算通过：没检查过的那部分不能被算进「通过」。
    // 这是「空跑必须是 2」的另一半——此前只堵住了全空，漏掉了部分失败。
    expect(await main([dir, '--quiet'], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('未能分析')
  })

  it('accepts a valid pack and rejects a broken one', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)

    // 规则包放在扫描目录之外：它同样是 .json，留在里面会被当轨迹解析。
    const goodPack = join(tempDir(), 'pack.json')
    writeFileSync(goodPack, JSON.stringify(DEFAULT_PACK))
    expect(await main([dir, '--pack', goodPack, '--quiet'], capture().io)).toBe(EXIT.ok)

    const badPack = join(tempDir(), 'bad-pack.json')
    writeFileSync(badPack, JSON.stringify({ ...DEFAULT_PACK, rules: [{ id: 'x' }] }))
    const broken = capture()
    expect(await main([dir, '--pack', badPack, '--quiet'], broken.io)).toBe(EXIT.error)
    expect(broken.chunks.err).toContain('规则包校验失败')
  })

  it('resolves builtin pack aliases case-insensitively', async () => {
    expect(resolvePackAlias('en')?.name).toBe(BUILTIN_PACK_EN.name)
    expect(resolvePackAlias('  EN ')?.name).toBe(BUILTIN_PACK_EN.name)
    expect(resolvePackAlias('builtin-en')?.name).toBe(BUILTIN_PACK_EN.name)
    expect(resolvePackAlias('zh')?.name).toBe(DEFAULT_PACK.name)
    expect(resolvePackAlias('nope')).toBeNull()
  })

  it('produces a fully English report with --pack en --locale en', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    trace(dir, 'broken.json', BROKEN)
    const out = join(dir, 'out')

    expect(await main([dir, '--pack', 'en', '--locale', 'en', '--out', out, '--quiet'], capture().io)).toBe(
      EXIT.ok,
    )

    const markdown = readFileSync(join(out, 'report.md'), 'utf8')
    expect(markdown).toContain('# Trajectory QA Report')
    expect(markdown).toContain('Builtin pack · EN v1')
    expect(markdown).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('reports an unreadable pack file', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const missing = join(dir, 'no-pack.json')
    const { io, chunks } = capture()
    expect(await main([dir, '--pack', missing, '--quiet'], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('规则包校验失败')
  })
})

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

describe('validation happens before anything that costs money', () => {
  const ENV = { TQA_LLM_BASE_URL: 'https://llm.test/v1', TQA_LLM_MODEL: 'm', TQA_LLM_API_KEY: 'k' }

  it('rejects a bad --pack-compare file before making a single --semantic call', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    let calls = 0
    const { io, chunks } = capture()

    const code = await main([dir, '--semantic', '--pack-compare', join(dir, 'nope.pack.json')], io, {
      env: ENV,
      transport: async () => {
        calls += 1
        return { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }) }
      },
    })

    expect(code).toBe(EXIT.error)
    expect(chunks.err).toContain('规则包')
    // 之前是先把额度烧完，再告诉你规则包路径写错了
    expect(calls).toBe(0)
  })
})

describe('an unwritable --out is an error message, not a stack trace', () => {
  function blockedOut(dir: string): string {
    // 把 --out 指到一个已存在的**文件**上：mkdir 必然失败。
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    return join(blocker, 'sub')
  }

  it('in the plain report branch', async () => {
    const dir = tempDir()
    trace(dir, 'a.json', CLEAN)
    const { io, chunks } = capture()
    const input = join(dir, 'a.json')
    expect(await main([input, '--out', blockedOut(dir)], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('写入')
  })

  it('in the --compare branch', async () => {
    const dir = tempDir()
    trace(dir, 'a.json', CLEAN)
    trace(dir, 'b.json', BROKEN)
    const { io, chunks } = capture()
    expect(await main([join(dir, 'a.json'), join(dir, 'b.json'), '--compare', '--out', blockedOut(dir)], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('写入')
  })

  it('in the --pack-compare branch', async () => {
    const dir = tempDir()
    trace(dir, 'a.json', CLEAN)
    const { io, chunks } = capture()
    expect(await main([join(dir, 'a.json'), '--pack-compare', 'en', '--out', blockedOut(dir)], io)).toBe(EXIT.error)
    expect(chunks.err).toContain('写入')
  })
})

describe('semantic review', () => {
  it('completes a versioned base url but leaves custom proxy paths alone', () => {
    expect(chatCompletionsUrl('https://token.sensenova.cn/v1')).toBe(
      'https://token.sensenova.cn/v1/chat/completions',
    )
    expect(chatCompletionsUrl('https://token.sensenova.cn/v1/')).toBe(
      'https://token.sensenova.cn/v1/chat/completions',
    )
    expect(chatCompletionsUrl('https://host/v1/chat/completions')).toBe(
      'https://host/v1/chat/completions',
    )
    // 本地代理自带路径：拼一层就成了 .../api/chat/chat/completions，等于把能用的配置改坏。
    expect(chatCompletionsUrl('http://127.0.0.1:18880/api/chat')).toBe('http://127.0.0.1:18880/api/chat')
    expect(chatCompletionsUrl('   ')).toBe('')
  })

  it('takes the base url from TQA_LLM_BASE_URL when no full url is given', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const urls: string[] = []
    const { io } = capture()

    await main([dir, '--semantic', '--quiet'], io, {
      env: {
        TQA_LLM_BASE_URL: 'https://token.sensenova.cn/v1',
        TQA_LLM_MODEL: 'm',
        TQA_LLM_API_KEY: 'k',
      },
      transport: async (request) => {
        urls.push(request.url)
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }),
        }
      },
    })

    expect(urls).toEqual(['https://token.sensenova.cn/v1/chat/completions'])
  })

  const JUDGEMENT = JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify({
            findings: [
              { category: 'unsafe', step: 2, severity: 'error', quote: '原文', reason: '泄露了手机号' },
            ],
          }),
        },
      },
    ],
  })

  it('refuses to run without configuration', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const { io, chunks } = capture()

    expect(await main([dir, '--semantic'], io, { env: {} })).toBe(EXIT.error)
    expect(chunks.err).toContain('语义复核缺少配置')
    expect(chunks.err).toContain('TQA_LLM_API_KEY')
  })

  it('merges model findings into the score and reports them', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const out = join(dir, 'out')
    const calls: { apiKey: string }[] = []
    const { io, chunks } = capture()

    const code = await main(
      [dir, '--semantic', '--llm-url', 'https://llm.example/v1', '--llm-model', 'm', '--out', out, '--quiet'],
      io,
      {
        env: { TQA_LLM_API_KEY: 'k-123' },
        transport: async (request) => {
          calls.push({ apiKey: request.apiKey })
          return { ok: true, status: 200, text: JUDGEMENT }
        },
      },
    )

    expect(code).toBe(EXIT.ok)
    expect(calls).toHaveLength(1)
    expect(chunks.out).toContain('语义复核：1 个会话，1 条判定')
    const report = readFileSync(join(out, 'report.md'), 'utf8')
    expect(report).toContain('安全或合规风险')
    expect(report).toContain('泄露了手机号')
  })

  it('degrades to rule findings when the model call fails', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const { io, chunks } = capture()

    const code = await main(
      [dir, '--semantic', '--llm-url', 'https://llm.example/v1', '--llm-model', 'm', '--quiet'],
      io,
      {
        env: { TQA_LLM_API_KEY: 'k' },
        transport: async () => ({ ok: false, status: 400, text: 'bad request' }),
      },
    )

    // 语义失败不改变退出码：规则结论照旧可用。
    expect(code).toBe(EXIT.ok)
    expect(chunks.out).toContain('语义复核失败 1 次')
  })

  it('prints the prompt on --semantic-dry-run and never calls the model', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    let called = 0
    const { io, chunks } = capture()

    const code = await main([dir, '--semantic-dry-run'], io, {
      env: {},
      transport: async () => {
        called += 1
        return { ok: true, status: 200, text: '{}' }
      },
    })

    expect(code).toBe(EXIT.ok)
    expect(called).toBe(0)
    const prompt = JSON.parse(chunks.out) as { role: string; content: string }[]
    expect(prompt[0]?.content).toContain('只输出 JSON')
    expect(prompt[1]?.content).toContain('查一下报销标准')
  })

  it('honours --semantic-limit', async () => {
    const dir = tempDir()
    trace(dir, 'a.json', CLEAN)
    trace(dir, 'b.json', CLEAN)
    let called = 0
    const { io, chunks } = capture()

    await main(
      [dir, '--semantic', '--llm-url', 'u', '--llm-model', 'm', '--semantic-limit', '1', '--quiet'],
      io,
      {
        env: { TQA_LLM_API_KEY: 'k' },
        transport: async () => {
          called += 1
          return {
            ok: true,
            status: 200,
            text: JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }),
          }
        },
      },
    )

    expect(called).toBe(1)
    expect(chunks.out).toContain('语义复核：1 个会话')
    expect(chunks.err).toContain('--semantic-limit')
  })
})

describe('loadPack', () => {
  it('parses the builtin pack round-trip', async () => {
    const dir = tempDir()
    const path = join(dir, 'pack.json')
    writeFileSync(path, JSON.stringify(DEFAULT_PACK))
    const loaded = loadPack(path)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.pack.rules.length).toBe(DEFAULT_PACK.rules.length)
  })

  it('reports json syntax errors verbatim', async () => {
    const dir = tempDir()
    const path = join(dir, 'pack.json')
    writeFileSync(path, '{oops')
    const loaded = loadPack(path)
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.message.length).toBeGreaterThan(0)
  })
})

describe('serve subcommand', () => {
  it('refuses to start without LLM configuration', async () => {
    const { io, chunks } = capture()
    expect(await main(['serve'], io, { env: {} })).toBe(EXIT.error)
    expect(chunks.err).toContain('TQA_LLM_API_KEY')
  })

  it('starts, prints where it listens, and stops on the abort signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const { io, chunks } = capture()

    const code = await main(['serve', '--port', '0', '--token', 'abc'], io, {
      env: { TQA_LLM_BASE_URL: 'https://llm.test/v1', TQA_LLM_MODEL: 'm', TQA_LLM_API_KEY: 'k' },
      signal: controller.signal,
    })

    expect(code).toBe(EXIT.ok)
    // 端口 0 由系统分配，打印的必须是**实际**端口而不是命令行里的 0。
    expect(chunks.out).toContain('http://127.0.0.1:')
    expect(chunks.out).not.toContain('http://127.0.0.1:0\n')
    expect(chunks.out).toContain('agentToken')
  })

  it('warns when the bind address is not a loopback one', async () => {
    const controller = new AbortController()
    controller.abort()
    const { io, chunks } = capture()

    await main(['serve', '--port', '0', '--host', '0.0.0.0'], io, {
      env: { TQA_LLM_BASE_URL: 'https://llm.test/v1', TQA_LLM_MODEL: 'm', TQA_LLM_API_KEY: 'k' },
      signal: controller.signal,
    })

    expect(chunks.err).toContain('不是回环地址')
  })
})

describe('cli contract', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string
    bin: Record<string, string>
  }

  it('keeps the reported version in sync with package.json', async () => {
    expect(CLI_VERSION).toBe(pkg.version)
  })

  it('points the bin entry at the built bundle', async () => {
    expect(pkg.bin['trajectory-qa']).toBe('dist-cli/qa.mjs')
  })
})

describe('agent diagnosis', () => {
  const SUBMITTED = JSON.stringify({
    choices: [
      {
        message: {
          content: '',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: {
                name: 'submit_diagnosis',
                arguments: JSON.stringify({
                  verdict: '整体可用，短板在错误恢复。',
                  rootCauses: [{ cause: '工具报错后放弃', evidence: '第 2 步' }],
                  actions: [{ action: '提高扣分', ruleId: 'exec-tool-error' }],
                }),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 6 },
  })

  const PROPOSED = JSON.stringify({
    choices: [
      {
        message: {
          content: '',
          tool_calls: [
            {
              id: 'c0',
              type: 'function',
              function: {
                name: 'propose_pack',
                arguments: JSON.stringify({
                  rationale: '执行维扣分偏轻',
                  edits: [{ ruleId: 'exec-dead-loop', scoreImpact: 30 }],
                }),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 6 },
  })

  /** 按序回放若干回合：CLI 测试只关心「接得上」，不需要完整循环行为。 */
  function sequence(replies: string[]) {
    let index = 0
    return async () => {
      const text = replies[Math.min(index, replies.length - 1)] ?? ''
      index += 1
      return { ok: true, status: 200, text }
    }
  }

  const LLM_ENV = { TQA_LLM_BASE_URL: 'https://llm.test/v1', TQA_LLM_MODEL: 'm', TQA_LLM_API_KEY: 'k' }

  it('refuses to run without configuration', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const { io, chunks } = capture()

    expect(await main([dir, '--agent'], io, { env: {} })).toBe(EXIT.error)
    expect(chunks.err).toContain('诊断缺少配置')
    expect(chunks.err).toContain('TQA_LLM_API_KEY')
  })

  it('refuses to combine with --semantic', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const { io, chunks } = capture()
    let calls = 0

    const code = await main([dir, '--agent', '--semantic'], io, {
      env: LLM_ENV,
      transport: async () => {
        calls += 1
        return { ok: true, status: 200, text: SUBMITTED }
      },
    })

    expect(code).toBe(EXIT.error)
    expect(chunks.err).toContain('--semantic')
    // 冲突要在烧配额之前被发现
    expect(calls).toBe(0)
  })

  it('refuses to combine with --compare', async () => {
    const dir = tempDir()
    trace(dir, 'a.json', CLEAN)
    trace(dir, 'b.json', CLEAN)
    const { io } = capture()

    expect(await main([dir, '--agent', '--compare'], io, { env: LLM_ENV })).toBe(EXIT.error)
  })

  it('prints the prompt and tool list on a dry run, calling nothing', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const { io, chunks } = capture()
    let calls = 0

    const code = await main([dir, '--agent-dry-run'], io, {
      env: {},
      transport: async () => {
        calls += 1
        return { ok: true, status: 200, text: SUBMITTED }
      },
    })

    expect(code).toBe(EXIT.ok)
    expect(calls).toBe(0)
    expect(chunks.out).toContain('submit_diagnosis')
    expect(chunks.out).toContain('数字只能来自工具')
  })

  it('puts --agent-task into the prompt so the model can be pointed at one question', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const { io, chunks } = capture()

    const code = await main([dir, '--agent-dry-run', '--agent-task', '只看工具报错后有没有重试'], io, { env: {} })

    expect(code).toBe(EXIT.ok)
    expect(chunks.out).toContain('只看工具报错后有没有重试')
  })

  it('writes agent.md and agent.json next to the report', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const out = join(dir, 'out')
    const { io, chunks } = capture()

    const code = await main([dir, '--agent', '--out', out, '--quiet'], io, {
      env: LLM_ENV,
      transport: async () => ({ ok: true, status: 200, text: SUBMITTED }),
    })

    expect(code).toBe(EXIT.ok)
    const markdown = readFileSync(join(out, 'agent.md'), 'utf8')
    const json = JSON.parse(readFileSync(join(out, 'agent.json'), 'utf8')) as { stopReason: string }
    expect(markdown).toContain('轨迹诊断报告')
    expect(markdown).toContain('整体可用')
    expect(json.stopReason).toBe('submitted')
    // 隐私提示走 stderr，且不被 --quiet 吞掉
    expect(chunks.err).toContain('llm.test')
    expect(chunks.out).toContain('1 次工具调用')
  })

  it('saves the trace to the requested path', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const tracePath = join(dir, 'trace.json')
    const { io } = capture()

    const code = await main([dir, '--agent', '--agent-trace', tracePath, '--quiet'], io, {
      env: LLM_ENV,
      transport: async () => ({ ok: true, status: 200, text: SUBMITTED }),
    })

    expect(code).toBe(EXIT.ok)
    expect(existsSync(tracePath)).toBe(true)
  })

  it('writes a candidate pack that --pack can load as-is', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const out = join(dir, 'out')
    const { io, chunks } = capture()

    const code = await main([dir, '--agent', '--out', out, '--quiet'], io, {
      env: LLM_ENV,
      transport: sequence([PROPOSED, SUBMITTED]),
    })

    expect(code).toBe(EXIT.ok)
    const packPath = join(out, 'proposal.pack.json')
    expect(existsSync(packPath)).toBe(true)

    // 端到端的关键一条：静态检查不等于「能当 --pack 用」，真的加载一遍。
    const loaded = loadPack(packPath)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.pack.name).toContain('提案 1')
    expect(loaded.pack.rules.find((rule) => rule.id === 'exec-dead-loop')?.scoreImpact).toBe(30)

    const markdown = readFileSync(join(out, 'agent.md'), 'utf8')
    expect(markdown).toContain('规则包提案')
    expect(chunks.out).toContain('proposal.pack.json')
  })

  it('says how to save proposals when there is no --out', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const { io, chunks } = capture()

    const code = await main([dir, '--agent', '--quiet'], io, {
      env: LLM_ENV,
      transport: sequence([PROPOSED, SUBMITTED]),
    })

    expect(code).toBe(EXIT.ok)
    expect(chunks.err).toContain('--out')
    expect(chunks.err).toContain('规则包提案')
  })

  it('does not throw when --out is unwritable, and still prints the diagnosis it paid for', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const out = join(dir, 'out')
    // 普通报告（report.*）先写、能写成功；只有 agent.md 是个目录，写它必然失败。
    // （--out 整个不可写时，普通报告分支先失败并直接返回，智能体根本不会跑，也就没花钱。）
    mkdirSync(join(out, 'agent.md'), { recursive: true })
    const { io, chunks } = capture()

    const code = await main([join(dir, 'clean.json'), '--agent', '--out', out], io, {
      env: LLM_ENV,
      transport: async () => ({ ok: true, status: 200, text: SUBMITTED }),
    })

    // 之前这里会让 main() 带着一份栈 reject；现在是退出码 2 加一条写盘错误
    expect(code).toBe(EXIT.error)
    expect(chunks.err).toContain('写入')
    // 诊断已经花了钱：结论不能因为 agent.md 写不进去就丢掉
    expect(chunks.out).toContain('# 轨迹诊断报告')
  })

  it('never starts the paid diagnosis when --out cannot be written at all', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    const { io } = capture()
    let calls = 0

    const code = await main([join(dir, 'clean.json'), '--agent', '--out', join(blocker, 'sub')], io, {
      env: LLM_ENV,
      transport: async () => {
        calls += 1
        return { ok: true, status: 200, text: SUBMITTED }
      },
    })

    expect(code).toBe(EXIT.error)
    expect(calls).toBe(0)
  })

  it('exits 2 when the endpoint fails, after still writing the report', async () => {
    const dir = tempDir()
    trace(dir, 'clean.json', CLEAN)
    const out = join(dir, 'out')
    const { io, chunks } = capture()

    const code = await main([dir, '--agent', '--out', out, '--quiet'], io, {
      env: LLM_ENV,
      transport: async () => ({ ok: false, status: 500, text: 'boom' }),
    })

    expect(code).toBe(EXIT.error)
    expect(chunks.err).toContain('诊断失败')
    // 失败也得留下证据：报告照写。
    expect(existsSync(join(out, 'agent.md'))).toBe(true)
  })
})
