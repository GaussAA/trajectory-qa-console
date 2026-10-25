/** 分层检查：跑 dependency-cruiser，并核对它真的扫到了源文件。
 *
 *  为什么要多这一步：dependency-cruiser 找不到可用的 TypeScript 解析器时，不报错，而是
 *  "0 modules cruised" 然后退出码 0——守卫悄悄失效，还显示通过。TS 7 的 API 还没公布，
 *  它只能靠 swc 解析；哪天 swc 没装上、或配置里的 parser 被改掉，这里要能立刻看出来。 */

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'src'

/** 磁盘上 src 下的 .ts/.tsx 文件数。 */
function countSources(dir) {
  let n = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) n += countSources(path)
    else if (/\.tsx?$/.test(entry.name)) n += 1
  }
  return n
}

let json
let failed = false
try {
  json = execFileSync('node', ['node_modules/dependency-cruiser/bin/dependency-cruiser.mjs', SRC, '--output-type', 'json'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
} catch (error) {
  // 有违规时 depcruise 退出码非 0，但 stdout 里仍是完整的 JSON。
  json = String(error.stdout ?? '')
  failed = true
}

let report
try {
  report = JSON.parse(json)
} catch {
  console.error('✗ 分层检查：dependency-cruiser 没有输出可解析的 JSON')
  process.exit(2)
}

const modules = report.modules.filter((m) => /\.tsx?$/.test(m.source)).length
const onDisk = countSources(SRC)
// 允许少量出入（例如只被 JSON 引用的文件），但不能差太多：差太多说明解析器没生效。
if (modules < onDisk * 0.9) {
  console.error(`✗ 分层检查只扫到 ${modules} 个模块，磁盘上有 ${onDisk} 个 .ts/.tsx 文件。解析器多半没生效，检查结果不可信。`)
  process.exit(2)
}

const violations = report.summary.violations.filter((v) => v.rule.severity === 'error')
if (failed || violations.length > 0) {
  console.error(`✗ 分层检查：${violations.length} 处违规`)
  for (const v of violations) console.error(`  ${v.rule.name}: ${v.from} → ${v.to}`)
  process.exit(1)
}
console.log(`✓ 分层检查通过 · 扫描 ${modules} 个模块（磁盘上 ${onDisk} 个 .ts/.tsx）`)
