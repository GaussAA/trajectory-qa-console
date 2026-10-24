import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'

/** 每个 [目录, 禁止导入的同级层] 按目录深度各生成一条配置：深度 d 的文件要走 d 个 `../` 才到 src/，
 *  所以只匹配 `^(\.\./){d}层(/|$)`。不用 glob：`**\/core` 会误伤 i18n 内部合法的 `./core`，
 *  而 `../app/x` 这类相对路径 glob 又匹配不到。各深度的 files 互不重叠，规则不会相互覆盖。 */
const MAX_DEPTH = 3
function layerRules(layers) {
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
