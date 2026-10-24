#!/usr/bin/env node
/** 构建产物的冒烟测试：只认「打出来的那个文件」跑得通。
 *
 *  单元测试跑的是源码，这里跑的是 `dist-cli/qa.mjs`——shebang、bundling、
 *  退出码与「--out 真的落了盘」都在这一层验证。CI 用同一条命令。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BUNDLE = 'dist-cli/qa.mjs'
const problems = []

function run(args) {
  const result = spawnSync(process.execPath, [BUNDLE, ...args], { encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function check(name, condition, detail) {
  if (!condition) problems.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

if (!existsSync(BUNDLE)) {
  console.error(`✗ 未找到 ${BUNDLE}，请先 pnpm build:cli`)
  process.exit(1)
}

const source = readFileSync(BUNDLE, 'utf8')
check('产物带 shebang', source.startsWith('#!/usr/bin/env node'))

// 自包含：除 node: 内置模块外不应有裸模块名，否则运行时还得装 node_modules。
const bareImports = [...source.matchAll(/^import\s[^'"]*from\s+['"]([^'"]+)['"]/gm)]
  .map((match) => match[1])
  .filter((specifier) => !specifier.startsWith('node:') && !specifier.startsWith('.'))
check('产物只依赖 node 内置模块', bareImports.length === 0, bareImports.join(', '))

const help = run(['--help'])
check('--help 退出码 0', help.code === 0, `实际 ${help.code}`)
check('--help 有用法', help.stdout.includes('trajectory-qa') && help.stdout.includes('--fail-below'))

const pass = run(['examples', '--quiet'])
check('无门禁时退出码 0', pass.code === 0, `实际 ${pass.code}：${pass.stderr.trim()}`)
check('输出汇总行', /\d+ 个文件 · \d+ 个会话/.test(pass.stdout), pass.stdout.trim())

const gate = run(['examples', '--fail-below', '90', '--quiet'])
check('门禁不通过时退出码 1', gate.code === 1, `实际 ${gate.code}`)
check('门禁结论可读', gate.stdout.includes('未通过'), gate.stdout.trim())

const usage = run(['--nope'])
check('未知选项退出码 2', usage.code === 2, `实际 ${usage.code}`)
check('未知选项给出提示', usage.stderr.includes('--help'))

const english = run(['examples', '--locale', 'en', '--quiet'])
check('英文输出', /files · \d+ sessions/.test(english.stdout), english.stdout.trim())

const dryRun = run(['examples', '--semantic-dry-run'])
check('--semantic-dry-run 退出码 0', dryRun.code === 0, `实际 ${dryRun.code}`)
check('试跑输出提示词', dryRun.stdout.includes('只输出 JSON') && dryRun.stdout.includes('trajectory:'))

const noKey = run(['examples', '--semantic'])
check('缺配置时退出码 2', noKey.code === 2, `实际 ${noKey.code}`)
check('缺配置给出变量名', noKey.stderr.includes('TQA_LLM_API_KEY'))

// 智能体试跑：零成本，但能验证参数接线、系统提示与工具清单真的打进了产物。
const agentDry = run(['examples', '--agent-dry-run'])
check('--agent-dry-run 退出码 0', agentDry.code === 0, `实际 ${agentDry.code}`)
check(
  '试跑列出工具与纪律',
  agentDry.stdout.includes('submit_diagnosis') && agentDry.stdout.includes('数字只能来自工具'),
)
check('试跑不打印诊断摘要', !agentDry.stdout.includes('次工具调用'))

const agentConflict = run(['examples', '--agent', '--semantic'])
check('--agent 与 --semantic 互斥退出码 2', agentConflict.code === 2, `实际 ${agentConflict.code}`)

const agentNoKey = run(['examples', '--agent'])
check('智能体缺配置退出码 2', agentNoKey.code === 2, `实际 ${agentNoKey.code}`)
check('智能体缺配置给出变量名', agentNoKey.stderr.includes('TQA_LLM_API_KEY'))

const outDir = mkdtempSync(join(tmpdir(), 'tqa-smoke-'))
try {
  const written = run(['examples', '--out', outDir, '--quiet'])
  check('--out 退出码 0', written.code === 0, `实际 ${written.code}`)
  check('写出 report.md', existsSync(join(outDir, 'report.md')))
  check('写出 report.json', existsSync(join(outDir, 'report.json')))
  check('报告含标题', readFileSync(join(outDir, 'report.md'), 'utf8').startsWith('# '))

  const cmpDir = join(outDir, 'cmp')
  const cmp = run([
    'examples/healthy.json',
    'examples/tool-failure.json',
    '--compare',
    '--out',
    cmpDir,
    '--quiet',
  ])
  check('--compare 退出码 0', cmp.code === 0, `实际 ${cmp.code}：${cmp.stderr.trim()}`)
  check('写出 compare.md', existsSync(join(cmpDir, 'compare.md')))
  check('对比报告含标题', readFileSync(join(cmpDir, 'compare.md'), 'utf8').startsWith('# '))

  const cmpHtmlDir = join(outDir, 'cmp-html')
  const cmpHtml = run([
    'examples/healthy.json',
    'examples/tool-failure.json',
    '--compare',
    '--format',
    'html',
    '--out',
    cmpHtmlDir,
    '--quiet',
  ])
  check(
    '--compare --format html 退出码 0',
    cmpHtml.code === 0,
    `实际 ${cmpHtml.code}：${cmpHtml.stderr.trim()}`,
  )
  const cmpHtmlText = readFileSync(join(cmpHtmlDir, 'compare.html'), 'utf8')
  check(
    '对比 HTML 自包含（无外链、无脚本）',
    cmpHtmlText.startsWith('<!doctype html>') &&
      !/<script/i.test(cmpHtmlText) &&
      !/<link\b/i.test(cmpHtmlText),
  )

  const cmpBad = run(['examples/healthy.json', '--compare', '--quiet'])
  check('单文件对比退出码 2', cmpBad.code === 2, `实际 ${cmpBad.code}`)

  const htmlDir = join(outDir, 'html')
  const htmlRun = run(['examples', '--out', htmlDir, '--format', 'html', '--quiet'])
  check('--format html 退出码 0', htmlRun.code === 0, `实际 ${htmlRun.code}：${htmlRun.stderr.trim()}`)
  const htmlPath = join(htmlDir, 'report.html')
  check('写出 report.html', existsSync(htmlPath))
  check(
    'html 是唯一产物',
    !existsSync(join(htmlDir, 'report.md')) && !existsSync(join(htmlDir, 'report.json')),
  )
  const html = readFileSync(htmlPath, 'utf8')
  check('html 以 doctype 开头', html.startsWith('<!doctype html>'))
  check(
    'html 自包含（无外链、无脚本）',
    !/<script/i.test(html) && !/<link\b/i.test(html) && !/src=["']https?:/i.test(html),
  )

  const pkDir = join(outDir, 'pk')
  const pk = run(['examples', '--pack-compare', 'en', '--out', pkDir, '--quiet'])
  check('--pack-compare 退出码 0', pk.code === 0, `实际 ${pk.code}：${pk.stderr.trim()}`)
  check(
    '口径对比双产物',
    existsSync(join(pkDir, 'pack-compare.md')) && existsSync(join(pkDir, 'pack-compare.json')),
  )

  const enDir = join(outDir, 'en')
  const englishPack = run(['examples', '--pack', 'en', '--locale', 'en', '--out', enDir, '--quiet'])
  check('--pack en 退出码 0', englishPack.code === 0, `实际 ${englishPack.code}`)
  const englishReport = readFileSync(join(enDir, 'report.md'), 'utf8')
  check('英文规则包 + 英文语言 = 全英文报告', !/[\u4e00-\u9fff]/.test(englishReport), '报告仍含中文')
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

if (problems.length > 0) {
  console.error('✗ CLI 冒烟失败：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(
  '✓ CLI 冒烟通过：help / 通过 / 门禁 / 用法错误 / 英文 / 英文包 / 语义试跑 / 智能体试跑与互斥 / 对比 / HTML / 落盘',
)
