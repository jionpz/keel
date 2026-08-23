import { defineConfig } from 'vitest/config'
import { ACCEPTANCE_GLOB, BASE_EXCLUDE, SHARED_TEST_CONFIG } from './vitest.shared.js'

/**
 * 验收测试的配置 —— 只跑 `*.acceptance.test.ts`。
 *
 * 它是**独立命令**（`pnpm run test:acceptance`）而不是默认 check 的一部分，
 * 理由见 `src/acceptance/README.md`。
 *
 * ⚠️ 刻意**不用** `mergeConfig` 继承 `vitest.config.ts`：
 * 那样会把基础配置里「排除验收测试」那条一并继承过来（数组是拼接的），
 * 于是这个命令一个测试都跑不到却退出 0 —— 正是本任务要消灭的假绿。
 */
export default defineConfig({
  test: {
    ...SHARED_TEST_CONFIG,

    include: [`src/**/${ACCEPTANCE_GLOB.replace('**/', '')}`],
    exclude: BASE_EXCLUDE,

    // 真实模型调用慢：v0.1 判据实测 50–150 秒，默认 5 秒必超时。
    testTimeout: 900_000,
    hookTimeout: 120_000,

    // 一个都没匹配上要报错 —— 见上面关于假绿的说明。
    passWithNoTests: false,
  },
})
