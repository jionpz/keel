import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
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
  },
})
