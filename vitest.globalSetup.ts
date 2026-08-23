import { execFileSync } from 'node:child_process'

/**
 * 测试前置：确保测试库已迁移。
 *
 * 不做「数据库不可用就跳过 DB 测试」的处理 —— 那是假绿：
 * 不变量测试全被跳过时，输出和「全部通过」看起来一样。
 * 数据库连不上就让测试失败，把问题暴露出来。
 */
export default function setup(): void {
  const url = process.env.KEEL_DATABASE_URL ?? 'postgres://localhost/keel_test'
  execFileSync('node_modules/.bin/node-pg-migrate', ['up'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  })
}
