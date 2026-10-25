/** oxlint 配置（替代 ESLint）。规则清单取自迁移前 ESLint 实际生效的那 71 条（含 tseslint.recommended），
 *  外加几条类型感知规则。oxlint 不依赖 `typescript` 包，所以不再卡在 TS 7 上。
 *
 *  分层检查（低层不得导入高层）和「生产代码不得导入 test-support」不在这里：
 *  它们由 dependency-cruiser 按解析后的真实路径判断，见 .dependency-cruiser.cjs 与 scripts/check-layers.mjs。 */

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
  // 类型感知规则（需要 --type-aware 与 oxlint-tsgolint）。都是在真实代码上零命中、
  // 且用故意写坏的探针验证过会触发的几条。
  // 没启用 no-unnecessary-type-assertion 和 no-base-to-string：前者在 compare/sessions.ts 里命中 25 处
  // noUncheckedIndexedAccess 下的 `as Step`，后者在 normalize.ts 里命中 14 处对 unknown 的有意容错。
  'typescript/no-floating-promises': 'error',
  'typescript/no-misused-promises': 'error',
  'typescript/await-thenable': 'error',
  'typescript/no-for-in-array': 'error',
  'typescript/restrict-plus-operands': 'error',
}
const TEST_FILES = ['**/*.test.{ts,tsx}', '**/test-support.ts']

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
    // 旧配置只对 .ts/.tsx 开 no-console，scripts/*.mjs 是命令行工具，本来就要 console.log。
    { files: ['**/*.{ts,tsx}'], rules: { 'no-console': ['warn', { allow: ['warn', 'error'] }] } },
    { files: TEST_FILES, rules: { 'no-console': 'off' } },
  ],
}
