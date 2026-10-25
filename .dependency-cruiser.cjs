/** 分层检查（按解析后的真实路径判断，不依赖目录深度）。
 *  低层不得导入高层；测试文件同样受限。i18n/core.ts 不依赖 React，各层都可以直接用。 */

const LAYERS = [
  ['core', ['app', 'ui', 'lib', 'cli']],
  ['i18n', ['core', 'app', 'ui', 'lib', 'cli']],
  ['lib', ['app', 'ui', 'cli']],
  ['app', ['ui', 'cli']],
  ['cli', ['ui']],
  ['ui', ['cli']],
]

const TEST = '(\\.test\\.tsx?|/test-support\\.ts)$'

module.exports = {
  forbidden: [
    ...LAYERS.map(([layer, forbidden]) => ({
      name: `${layer}-not-upward`,
      comment: `${layer} 不得导入 ${forbidden.join('、')} 层：依赖方向只能自上而下，见 CLAUDE.md 的分层约定。`,
      severity: 'error',
      from: { path: `^src/${layer}/` },
      to: { path: `^src/(${forbidden.join('|')})/` },
    })),
    {
      name: 'no-test-support-in-prod',
      comment: 'test-support.ts 只供测试文件使用，生产代码不得导入。',
      severity: 'error',
      from: { path: '^src/', pathNot: TEST },
      to: { path: '/test-support\\.ts$' },
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
  ],
  options: {
    // typescript 7 的 API 还没公布，dependency-cruiser 不认；用 swc 解析。
    parser: 'swc',
    tsConfig: { fileName: 'tsconfig.json' },
    doNotFollow: { path: 'node_modules' },
    includeOnly: '^src/',
  },
}
