import { configDefaults } from 'vitest/config'

/**
 * 两套配置共享的部分。
 *
 * 抽出来是因为验收配置**不能**用 `mergeConfig` 继承默认配置：
 * `mergeConfig` 对数组是**拼接**而非覆盖，于是基础配置里那条
 * 「排除 `*.acceptance.test.ts`」会被一并继承下来，
 * 结果验收命令一个测试都匹配不到 —— 而且是安静地匹配不到。
 *
 * 这个坑是反例验证抓出来的：故意把验收测试改名后，命令的报错
 * 暴露了 `exclude` 里仍有那条规则。
 */
export const SHARED_TEST_CONFIG = {
  globalSetup: ['./vitest.globalSetup.ts'],

  // 数据库测试必须串行。
  //
  // 多个测试文件共享同一个 Postgres，各自在 beforeEach 里 TRUNCATE ——
  // 并行执行时会互相清掉对方刚铺好的数据，表现为「单独跑全过、合起来跑就挂」。
  //
  // 替代方案是给每个文件分配独立 schema，但在当前规模下不值得那个复杂度。
  // 若日后测试变慢到成为问题，再考虑 per-file schema。
  fileParallelism: false,

  env: {
    KEEL_DATABASE_URL: process.env.KEEL_DATABASE_URL ?? 'postgres://localhost/keel_test',
  },
} as const

/** 两套配置都要排除的东西（node_modules、dist 等），不含测试分层规则 */
export const BASE_EXCLUDE = [...configDefaults.exclude]

/** 验收测试的文件名约定。分层规则只有这一条，两处引用同一个常量 */
export const ACCEPTANCE_GLOB = '**/*.acceptance.test.ts'
