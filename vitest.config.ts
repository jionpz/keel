import { defineConfig } from 'vitest/config'
import { ACCEPTANCE_GLOB, BASE_EXCLUDE, SHARED_TEST_CONFIG } from './vitest.shared.js'

export default defineConfig({
  test: {
    ...SHARED_TEST_CONFIG,

    // 验收测试不进默认 check —— 理由见 src/acceptance/README.md。
    //
    // 一句话：它们的断言依赖模型「说了什么」，因此天然有波动；
    // 一个 flaky 测试留在默认 check 里，会侵蚀 check 本身的可信度。
    //
    // 这**不是**「不可用就跳过」：它们没有被静默跳过，而是移到了
    // `pnpm run test:acceptance`，条件不满足时明确失败。
    exclude: [...BASE_EXCLUDE, ACCEPTANCE_GLOB],
  },
})
