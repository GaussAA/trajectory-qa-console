#!/usr/bin/env node
/** Artifact contract check.
 *
 *  "Single file, opens by double-click" is the product promise. A stray
 *  external <script>, a stylesheet link or an oversized bundle breaks that
 *  promise silently, so CI checks it on every run.
 */

import { readFileSync, statSync } from 'node:fs'

const file = process.argv[2] ?? 'dist/index.html'
const budgetKb = Number(process.env.ARTIFACT_BUDGET_KB ?? 1500)

let html
let bytes
try {
  html = readFileSync(file, 'utf8')
  bytes = statSync(file).size
} catch (error) {
  console.error(`✗ 找不到产物 ${file}：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const problems = []

if (/<script[^>]+\bsrc\s*=/i.test(html)) problems.push('存在外部脚本 <script src>')
if (/<link[^>]+rel=["']stylesheet["']/i.test(html)) problems.push('存在外部样式表 <link rel=stylesheet>')
if (/<img[^>]+\bsrc=["']https?:/i.test(html)) problems.push('存在远程图片引用')
if (!/id=["']root["']/.test(html)) problems.push('缺少 #root 挂载点，可能不是应用入口')
if (!/<style[\s>]/i.test(html) && !/style=/.test(html)) problems.push('未内联任何样式')

const kb = bytes / 1024
if (kb > budgetKb) problems.push(`产物 ${kb.toFixed(0)} KB 超过预算 ${budgetKb} KB`)

if (problems.length > 0) {
  console.error('✗ 单文件产物契约校验失败：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`✓ 单文件自包含 · ${kb.toFixed(0)} KB / 预算 ${budgetKb} KB · ${file}`)
