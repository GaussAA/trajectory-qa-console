#!/usr/bin/env node
/** 进程边界：把 argv 交给 `main`，把退出码交给 shell。
 *
 *  独立成文件的原因很实在——`main.ts` 里任何 `process.exitCode` 都会让
 *  「import 即副作用」，测试和将来的库用法都会被它绊住。这里只做三件事：
 *  取 argv、设置退出码、兜住未捕获异常。
 */

import { EXIT, main } from './main'

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.stderr.write(`✗ ${detail}\n`)
  process.exitCode = EXIT.error
}
