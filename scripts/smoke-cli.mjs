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

const outDir = mkdtempSync(join(tmpdir(), 'tqa-smoke-'))
try {
  const written = run(['examples', '--out', outDir, '--quiet'])
  check('--out 退出码 0', written.code === 0, `实际 ${written.code}`)
  check('写出 report.md', existsSync(join(outDir, 'report.md')))
  check('写出 report.json', existsSync(join(outDir, 'report.json')))
  check('报告含标题', readFileSync(join(outDir, 'report.md'), 'utf8').startsWith('# '))
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

if (problems.length > 0) {
  console.error('✗ CLI 冒烟失败：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log('✓ CLI 冒烟通过：help / 通过 / 门禁 / 用法错误 / 英文 / 落盘')
