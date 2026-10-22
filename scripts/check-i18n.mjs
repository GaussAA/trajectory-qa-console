#!/usr/bin/env node
/** Fails when UI source contains hardcoded CJK, which would bypass the
 *  dictionary and leave English users with a half-translated screen.
 *
 *  Comments are stripped first, so Chinese explanations remain welcome.
 *  Rule packs and core diagnostics are data/logic, not UI chrome, and are not
 *  scanned here. */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src/ui']
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

const problems = []
for (const file of ROOTS.flatMap(walk)) {
  const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  source.split('\n').forEach((line, index) => {
    const code = line.replace(/^\s*\/\/.*$/, '')
    if (CJK.test(code)) problems.push(`${file}:${index + 1}  ${code.trim()}`)
  })
}

if (problems.length > 0) {
  console.error('✗ UI 中存在硬编码中文，请移入 src/i18n 字典：')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

console.log('✓ UI 文案全部经字典，无硬编码中文')
