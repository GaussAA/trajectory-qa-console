/** oxlint 配置（替代 ESLint）。规则清单取自迁移前 ESLint 实际生效的那 71 条（含 tseslint.recommended），
 *  外加分层检查。oxlint 不依赖 `typescript` 包，所以不再卡在 TS 7 上。
 *
 *  分层：低层不得导入高层（见 CLAUDE.md「Architecture」），测试文件同样受限。
 *  按目录深度各生成一条 override：深度 d 的文件要走 d 个 `../` 才到 src/，所以只匹配
 *  `^(\.\./){d}层(/|$)`。不用 glob，原因同旧配置：`**\/core` 会误伤 i18n 内部合法的 `./core`。 */

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const MAX_DEPTH = 3

const LAYERS = [
  ['src/core', ['app', 'ui', 'lib', 'cli']],
  ['src/i18n', ['core', 'app', 'ui', 'lib', 'cli']],
  ['src/lib', ['app', 'ui', 'cli']],
  ['src/app', ['ui', 'cli']],
  ['src/cli', ['ui']],
  ['src/ui', ['cli']],
]

/** dir 下最深的子目录层数；没有子目录为 0。 */
function levelsBelow(dir) {
  let deepest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) deepest = Math.max(deepest, 1 + levelsBelow(join(dir, entry.name)))
  }
  return deepest
}

// 目录嵌套超过 MAX_DEPTH 时，最深一层的文件会悄悄漏检，所以宁可在这里直接报错。
for (const [dir] of LAYERS) {
  const needed = levelsBelow(join(ROOT, dir)) + 1
  if (needed > MAX_DEPTH) {
    throw new Error(
      `${dir} 的目录嵌套需要 ${needed} 层，超过 MAX_DEPTH=${MAX_DEPTH}。` +
        '请调大 oxlint.config.js 里的 MAX_DEPTH，否则最深一层的文件不受分层检查。',
    )
  }
}

const restrict = (patterns) => ({ 'no-restricted-imports': ['error', { patterns }] })

/** 生产代码不得导入 test-support.ts：它只服务测试，进了产物就把测试构造函数打进包里。
 *  no-restricted-imports 同时覆盖 import、export … from 与动态 import()。 */
const NO_TEST_SUPPORT = {
  regex: 'test-support$',
  message: 'test-support.ts 只供测试文件使用，生产代码不得导入。',
}

const layerPatterns = (dir, forbidden, depth) =>
  forbidden.map((layer) => ({
    regex: `^(\\.\\./){${depth}}${layer}(/|$)`,
    message: `${dir} 不得导入 ${layer} 层：依赖方向只能自上而下，见 CLAUDE.md 的分层约定。`,
  }))

/** 默认 error、无选项的规则（来自迁移前 ESLint 的生效清单）。 */
const PLAIN = [
  'typescript/ban-ts-comment',
  'typescript/no-array-constructor',
  'typescript/no-duplicate-enum-values',
  'typescript/no-empty-object-type',
  'typescript/no-explicit-any',
  'typescript/no-extra-non-null-assertion',
  'typescript/no-misused-new',
  'typescript/no-namespace',
  'typescript/no-non-null-asserted-optional-chain',
  'typescript/no-require-imports',
  'typescript/no-this-alias',
  'typescript/no-unnecessary-type-constraint',
  'typescript/no-unsafe-declaration-merging',
  'typescript/no-unsafe-function-type',
  'typescript/no-wrapper-object-types',
  'typescript/prefer-as-const',
  'typescript/prefer-namespace-keyword',
  'typescript/triple-slash-reference',
  'for-direction',
  'no-async-promise-executor',
  'no-case-declarations',
  'no-compare-neg-zero',
  'no-control-regex',
  'no-debugger',
  'no-delete-var',
  'no-dupe-else-if',
  'no-duplicate-case',
  'no-empty-character-class',
  'no-empty-static-block',
  'no-ex-assign',
  'no-loss-of-precision',
  'no-nonoctal-decimal-escape',
  'no-prototype-builtins',
  'no-regex-spaces',
  'no-sparse-arrays',
  'no-unassigned-vars',
  'no-unsafe-finally',
  'no-unused-labels',
  'no-unused-private-class-members',
  'no-useless-assignment',
  'no-useless-backreference',
  'no-useless-catch',
  'no-var',
  'prefer-rest-params',
  'prefer-spread',
  'react/rules-of-hooks',
  'require-yield',
]
/** 迁移前 ESLint 里带选项、但选项就是默认值的规则；这里不再重复写选项。 */
const DEFAULTS = [
  'no-cond-assign',
  'no-constant-binary-expression',
  'no-empty',
  'no-empty-pattern',
  'no-extra-boolean-cast',
  'no-fallthrough',
  'no-global-assign',
  'no-invalid-regexp',
  'no-irregular-whitespace',
  'no-misleading-character-class',
  'no-self-assign',
  'no-shadow-restricted-names',
  'no-unsafe-optional-chaining',
  'no-unused-expressions',
  'no-useless-escape',
  'prefer-const',
  'preserve-caught-error',
  'use-isnan',
  'valid-typeof',
]

const RULES = {
  ...Object.fromEntries([...PLAIN, ...DEFAULTS].map((name) => [name, 'error'])),
  // 以下是项目自己选的选项。
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  eqeqeq: ['error', 'smart'],
  'no-constant-condition': ['error', { checkLoops: 'allExceptWhileTrue' }],
  'react/exhaustive-deps': 'warn',
}
const SRC_TS = 'src/**/*.{ts,tsx}'
const TEST_FILES = ['**/*.test.{ts,tsx}', '**/test-support.ts']

/** 每个目录、每个深度各一条：文件在 dir 的第 n 层子目录里，要走 n+1 个 `../` 才到 src/。
 *  生产文件额外带 test-support 守卫；测试文件那份在后面的 overrides 里单列（后写的块生效）。 */
function layerOverrides(withTestSupportGuard) {
  return LAYERS.flatMap(([dir, forbidden]) =>
    Array.from({ length: MAX_DEPTH }, (_, index) => {
      const depth = index + 1
      const patterns = layerPatterns(dir, forbidden, depth)
      return {
        files: withTestSupportGuard
          ? [`${dir}/${'*/'.repeat(index)}*.{ts,tsx}`]
          : TEST_FILES.map((glob) => `${dir}/${'*/'.repeat(index)}${glob.replace('**/', '')}`),
        rules: restrict(withTestSupportGuard ? [...patterns, NO_TEST_SUPPORT] : patterns),
      }
    }),
  )
}

export default {
  plugins: ['typescript', 'react'],
  // 只开上面显式列出的规则，保证与迁移前的 ESLint 等价；默认的 correctness 类别留给单独评估。
  categories: { correctness: 'off' },
  rules: RULES,
  ignorePatterns: [
    'dist/**',
    'dist-cli/**',
    'coverage/**',
    'node_modules/**',
    '.workbuddy/**',
    'test-results/**',
    'playwright-report/**',
  ],
  overrides: [
    // 不在六个分层目录里的生产文件（main.tsx、workers）只需要 test-support 守卫。
    { files: [SRC_TS], rules: restrict([NO_TEST_SUPPORT]) },
    // 旧配置只对 .ts/.tsx 开 no-console，scripts/*.mjs 是命令行工具，本来就要 console.log。
    { files: ['**/*.{ts,tsx}'], rules: { 'no-console': ['warn', { allow: ['warn', 'error'] }] } },
    { files: TEST_FILES, rules: { 'no-console': 'off' } },
    ...layerOverrides(true),
    ...layerOverrides(false),
  ],
}
