#!/usr/bin/env node
/** Fails when a font size escapes the six-step scale.
 *
 *  Why a script and not discipline: the app shipped 137 raw `font-size` declarations,
 *  94 of them below 11px — text that is unreadable at normal viewing distance. That
 *  happened one convenient `9px` at a time. A scale nobody checks decays back into
 *  whatever the next feature needs, so the check has to be mechanical.
 *
 *  Rules:
 *   1. Every `font-size` in src/styles must be `var(--fs-*)`.
 *   2. tokens.css must define the whole scale, ascending, with 11px as the floor.
 *   3. Inline `fontSize` in TSX must not use raw px either.
 *   4. Every stylesheet must have balanced braces. This one exists because of a
 *      real slip: deleting a `@media` header while keeping its body left the file
 *      malformed, the following rules silently stopped applying, and the layout
 *      looked "almost right" for hours. A brace count would have caught it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const STYLE_ROOTS = ['src/styles']
const TSX_ROOTS = ['src/ui', 'src/app']
// src/lib 的导出报告（HTML）内嵌着自己的样式表，用的是裸 px，不走 var(--fs-*)：
// 它是独立文件，拿不到应用的 CSS 变量。所以这里不要求走标度，只守住同一条 11px 下限。
const LIB_ROOTS = ['src/lib']
const SCALE = ['--fs-xs', '--fs-sm', '--fs-base', '--fs-md', '--fs-lg', '--fs-xl']
const FLOOR_PX = 11

function walk(dir, pattern) {
  const files = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) files.push(...walk(path, pattern))
    else if (pattern.test(name)) files.push(path)
  }
  return files
}

const problems = []

/** 1 + 2：标度必须完整、递增、不低于下限。 */
const tokens = readFileSync('src/styles/tokens.css', 'utf8')
const declared = []
for (const token of SCALE) {
  const found = tokens.match(new RegExp(`${token}:\\s*([0-9.]+)px`))
  if (!found) {
    problems.push(`tokens.css 缺少 ${token}`)
    continue
  }
  const size = Number(found[1])
  declared.push({ token, size })
  if (size < FLOOR_PX) problems.push(`${token} = ${size}px，低于下限 ${FLOOR_PX}px`)
}
for (let index = 1; index < declared.length; index += 1) {
  if (declared[index].size <= declared[index - 1].size) {
    problems.push(
      `标度必须递增：${declared[index].token}(${declared[index].size}px) ≤ ${declared[index - 1].token}`,
    )
  }
}

/** 3：样式表里不许出现裸 px 字号（tokens.css 自己定义标度，除外）。 */
const styleFiles = STYLE_ROOTS.flatMap((root) => walk(root, /\.css$/))
for (const file of styleFiles) {
  if (file.endsWith('tokens.css')) continue
  const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  source.split('\n').forEach((line, index) => {
    if (!/font-size\s*:/.test(line)) return
    if (!/font-size\s*:\s*var\(--fs-[a-z]+\)/.test(line)) {
      problems.push(`${file}:${index + 1}  ${line.trim()}`)
    }
  })
}

/** 4：TSX 内联字号同样不许裸 px。 */
for (const file of TSX_ROOTS.flatMap((root) => walk(root, /\.tsx?$/))) {
  if (/\.test\.tsx?$/.test(file)) continue
  const source = readFileSync(file, 'utf8')
  source.split('\n').forEach((line, index) => {
    if (/fontSize\s*:\s*['"`]?[0-9.]+px/.test(line)) {
      problems.push(`${file}:${index + 1}  ${line.trim()}`)
    }
  })
}

/** 5：导出报告的内嵌样式守住 11px 下限（pt 按 4/3 换成 px）。 */
for (const file of LIB_ROOTS.flatMap((root) => walk(root, /\.ts$/))) {
  if (/\.test\.ts$/.test(file)) continue
  const source = readFileSync(file, 'utf8')
  source.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/font-size\s*:\s*([^;}]+)/g)) {
      const value = (match[1] ?? '').trim()
      const length = value.match(/^([0-9.]+)(px|pt)$/)
      // 非法值（比如批量替换时没展开的 `$211px`）会被浏览器整条丢掉，元素静默退回继承字号，
      // 而之前这里只匹配合法写法，所以它会被悄悄跳过。现在一律当成错误。
      if (!length) {
        problems.push(`${file}:${index + 1}  ${match[0].trim()}（不是合法的长度，浏览器会丢掉这条声明）`)
        continue
      }
      const px = length[2] === 'pt' ? Number(length[1]) * (4 / 3) : Number(length[1])
      if (px < FLOOR_PX) problems.push(`${file}:${index + 1}  ${match[0].trim()}（低于下限 ${FLOOR_PX}px）`)
    }
  })
}

/** 4：花括号平衡。去掉注释再数，否则注释里的花括号会误报。 */
for (const file of styleFiles) {
  const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const open = (source.match(/\{/g) ?? []).length
  const close = (source.match(/\}/g) ?? []).length
  if (open !== close) problems.push(`${file}  花括号不平衡：{ ${open} 个 vs } ${close} 个`)
}

if (problems.length > 0) {
  console.error('✗ 样式检查未过（字号须走标度、下限 11px；花括号须平衡）：')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

console.log(`✓ 字号全部走标度：${declared.map((item) => `${item.token}=${item.size}px`).join(' / ')}`)
