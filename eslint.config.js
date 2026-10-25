import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 每个 [目录, 禁止导入的同级层] 按目录深度各生成一条配置：深度 d 的文件要走 d 个 `../` 才到 src/，
 *  所以只匹配 `^(\.\./){d}层(/|$)`。不用 glob：`**\/core` 会误伤 i18n 内部合法的 `./core`，
 *  而 `../app/x` 这类相对路径 glob 又匹配不到。各深度的 files 互不重叠，规则不会相互覆盖。 */
const MAX_DEPTH = 3
const ROOT = dirname(fileURLToPath(import.meta.url))

/** dir 下最深的子目录层数；没有子目录为 0。 */
function levelsBelow(dir) {
  let deepest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) deepest = Math.max(deepest, 1 + levelsBelow(join(dir, entry.name)))
  }
  return deepest
}

function layerRules(layers) {
  // 文件在 dir 的第 n 层子目录里，要走 n+1 个 `../` 才到 src/。目录嵌套超过 MAX_DEPTH 时，
  // 最深一层的文件会悄悄漏检，所以宁可在这里直接报错。
  for (const [dir] of layers) {
    const needed = levelsBelow(join(ROOT, dir)) + 1
    if (needed > MAX_DEPTH) {
      throw new Error(
        `${dir} 的目录嵌套需要 ${needed} 层，超过 MAX_DEPTH=${MAX_DEPTH}。` +
          '请调大 eslint.config.js 里的 MAX_DEPTH，否则最深一层的文件不受分层检查。',
      )
    }
  }
  return layers.flatMap(([dir, forbidden]) =>
    Array.from({ length: MAX_DEPTH }, (_, index) => {
      const depth = index + 1
      return {
        files: [`${dir}/${'*/'.repeat(index)}*.{ts,tsx}`],
        rules: {
          'no-restricted-imports': [
            'error',
            {
              patterns: forbidden.map((layer) => ({
                regex: `^(\\.\\./){${depth}}${layer}(/|$)`,
                message: `${dir} 不得导入 ${layer} 层：依赖方向只能自上而下，见 CLAUDE.md 的分层约定。`,
              })),
            },
          ],
        },
      }
    }),
  )
}

export default tseslint.config(
  { ignores: ['dist/**', 'dist-cli/**', 'coverage/**', 'node_modules/**', '.workbuddy/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // TypeScript already resolves globals; no-undef duplicates it badly in TS.
      'no-undef': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  // 生产代码不得导入 test-support.ts：它只服务测试，进了产物就把测试构造函数打进包里。
  // 用 no-restricted-syntax 而不是 no-restricted-imports，免得和下面按深度生成的分层规则互相覆盖。
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', '**/test-support.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...['ImportDeclaration', 'ImportExpression', 'ExportNamedDeclaration', 'ExportAllDeclaration'].map(
          (type) => ({
            selector: `${type}[source.value=/test-support$/]`,
            message: 'test-support.ts 只供测试文件使用，生产代码不得导入。',
          }),
        ),
      ],
    },
  },
  // 分层：低层不得导入高层（见 CLAUDE.md「Architecture」）。测试文件同样受限，
  // 否则测试会悄悄把依赖方向写反。i18n/core.ts 不依赖 React，各层都可以直接用。
  ...layerRules([
    ['src/core', ['app', 'ui', 'lib', 'cli']],
    ['src/i18n', ['core', 'app', 'ui', 'lib', 'cli']],
    ['src/lib', ['app', 'ui', 'cli']],
    ['src/app', ['ui', 'cli']],
    ['src/cli', ['ui']],
    ['src/ui', ['cli']],
  ]),
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
  {
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
  prettier,
)
