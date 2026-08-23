/**
 * C1：由 docs/schemas/*.schema.json 生成 TypeScript 产物类型与 schema 常量。
 *
 * 这是 ADR-0002 选择 TypeScript 的**唯一实质收益**的兑现处：
 * 让「文档里的 schema」与「代码里的类型」机械对齐，而不是靠人维护同步。
 *
 * 产出两个文件，均提交进 git（否则 check:generated 的 git diff 无从检查）：
 *   src/generated/artifacts.ts  —— 类型定义
 *   src/generated/schemas.ts    —— schema 以 const 内联，供 ajv 运行时编译
 *
 * 为什么把 schema 内联成 .ts 而不是运行时读 JSON 文件：
 *   避免 JSON module import assertion 与打包路径问题，
 *   同时让 schema 一并落入 C1 的 git diff 检查范围。
 *
 * 输出必须**确定性**（稳定排序、不格式化），否则 git diff 检查会产生假阳性。
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from 'json-schema-to-typescript'

const SCHEMA_DIR = 'docs/schemas'
const OUT_DIR = 'src/generated'

const HEADER = `/**
 * ⚠️ 本文件由 scripts/generate-types.ts 自动生成 —— 请勿手改。
 *
 * 事实来源：docs/schemas/*.schema.json
 * 重新生成：pnpm run generate
 *
 * 手改本文件会立刻产生第二个事实来源，schema 从此不可信。
 * CI 会通过 \`pnpm run check:generated\` 检测手改（ADR-0002 L2/L4）。
 */
`

/** 文件名 → artifact kind（docs/06-artifacts.md §1 的 kind 列） */
function kindOf(filename: string): string {
  return filename.replace(/\.schema\.json$/, '').replace(/-/g, '_')
}

async function main(): Promise<void> {
  const files = readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.schema.json'))
    .sort() // 确定性输出

  if (files.length === 0) {
    console.error(`✗ ${SCHEMA_DIR} 下没有 schema —— 拒绝生成空文件`)
    process.exit(1)
  }

  // ---- artifacts.ts：类型 ----
  const typeBlocks: string[] = []
  for (const file of files) {
    const raw = readFileSync(join(SCHEMA_DIR, file), 'utf8')
    const schema = JSON.parse(raw)
    const ts = await compile(schema, schema.title ?? kindOf(file), {
      bannerComment: '',
      additionalProperties: false,
      format: false, // 不格式化 —— 确定性优先于美观，反正是生成物
      enableConstEnums: false,
    })
    typeBlocks.push(`// ── ${file} ──\n${ts.trim()}`)
  }
  writeFileSync(join(OUT_DIR, 'artifacts.ts'), `${HEADER}\n${typeBlocks.join('\n\n')}\n`, 'utf8')

  // ---- schemas.ts：schema 常量 + kind 注册表 ----
  const entries = files.map((file) => {
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8'))
    return `  ${JSON.stringify(kindOf(file))}: ${JSON.stringify(schema, null, 2)
      .split('\n')
      .join('\n  ')},`
  })

  const schemasFile = `${HEADER}
/** 全部产物 schema，按 artifact kind 索引。供 ajv 运行时编译。 */
export const SCHEMAS = {
${entries.join('\n')}
} as const

/** artifact kind 的联合类型，与 docs/06-artifacts.md §1 一致 */
export type ArtifactKind = keyof typeof SCHEMAS

/** 全部 kind 的运行时清单 */
export const ARTIFACT_KINDS = Object.keys(SCHEMAS) as ArtifactKind[]
`
  writeFileSync(join(OUT_DIR, 'schemas.ts'), schemasFile, 'utf8')

  console.log(
    `✓ 由 ${files.length} 份 schema 生成 ${OUT_DIR}/artifacts.ts 与 ${OUT_DIR}/schemas.ts`,
  )
  for (const f of files) console.log(`    ${f} → kind "${kindOf(f)}"`)
}

main().catch((err) => {
  console.error('✗ 生成失败：', err)
  process.exit(1)
})
