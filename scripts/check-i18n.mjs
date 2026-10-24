#!/usr/bin/env node
/** Fails when user-facing source contains hardcoded CJK, which would bypass the
 *  dictionary and leave English users with a half-translated screen.
 *
 *  Comments are stripped first, so Chinese explanations remain welcome.
 *
 *  Scope: src/ui, src/cli and src/app — everything a user can read. `src/core`
 *  is deliberately excluded: its messages are data/logic (parse notes, rule
 *  titles), and translating them is a separate design question recorded in
 *  CONTEXT.md. Diagnostic placeholders in src/app are locale-neutral by
 *  convention (telemetry event payloads), not translated. */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src/ui', 'src/cli', 'src/app']
const CJK = /[\u4e00-\u9fff]/

function walk(dir) {
  const files = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) files.push(...walk(path))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path)
  }
  return files
}

/** 去掉行尾注释，但保留字符串里的 `//`（例如 'https://…'）。 */
function stripLineComment(line) {
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote) {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '/' && line[index + 1] === '/') return line.slice(0, index)
  }
  return line
}

const problems = []
for (const file of ROOTS.flatMap(walk)) {
  const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  source.split('\n').forEach((line, index) => {
    const code = stripLineComment(line)
    if (CJK.test(code)) problems.push(`${file}:${index + 1}  ${code.trim()}`)
  })
}

if (problems.length > 0) {
  console.error('✗ UI/CLI/app 源码中存在硬编码中文，请移入 src/i18n 字典：')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

console.log('✓ UI 与 CLI、app 层文案全部经字典，无硬编码中文')
