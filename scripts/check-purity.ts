/**
 * C3 第 2 层：转移函数纯度检查（禁用全局）。
 *
 * 为什么需要这一层：
 *   .dependency-cruiser.cjs 的 transition-must-be-pure 规则拦得住 import 层面的一切
 *   （Node 内置 I/O、npm 依赖、其他平面），但 Date.now() / Math.random() / process.env
 *   是**全局**，不经 import —— 依赖图工具看不见它们。这个洞必须补，不是冗余。
 *
 * 手段的诚实评估：
 *   这是文本扫描，比 AST 分析弱。字符串字面量里出现 `//` 会让注释剥离出错。
 *   接受这个局限，理由是第 1 层已挡住绝大多数真实的不纯写法，
 *   而这一层零依赖、够用。若日后被绕过，再升级为 AST 分析。
 *
 * 见 ADR-0003 Consequences、docs/04-state-machine.md §5.3。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * 受检目录（相对仓库根）。
 *
 * transition 与 policy 都属 Control Plane，受同一条硬约束：
 * 必须可确定性重放，因此不得读时钟、不得引入非确定性。
 */
const GUARDED_DIRS = ['src/control/transition', 'src/control/policy']

/** 禁用的全局用法。key 用于报错信息，value 为匹配正则 */
const BANNED: ReadonlyArray<{ label: string; pattern: RegExp; why: string }> = [
  { label: 'Date.now()', pattern: /\bDate\s*\.\s*now\b/, why: '读时钟破坏可重放性' },
  { label: 'new Date()', pattern: /\bnew\s+Date\b/, why: '读时钟破坏可重放性' },
  { label: 'Date.parse()', pattern: /\bDate\s*\.\s*parse\b/, why: '应由调用方传入已解析的时间' },
  { label: 'Math.random()', pattern: /\bMath\s*\.\s*random\b/, why: '非确定性' },
  { label: 'process.*', pattern: /\bprocess\s*\./, why: '读进程环境属 I/O' },
  { label: 'require()', pattern: /\brequire\s*\(/, why: '动态加载属 I/O' },
  { label: 'dynamic import()', pattern: /\bimport\s*\(/, why: '动态加载属 I/O' },
  { label: 'globalThis', pattern: /\bglobalThis\b/, why: '可变全局状态' },
]

/** 剥离注释，避免"注释里提到 Date.now" 被误报 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full))
    } else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

interface Violation {
  file: string
  line: number
  label: string
  why: string
  text: string
}

function main(): void {
  const files: string[] = []

  for (const dir of GUARDED_DIRS) {
    let found: string[]
    try {
      found = collectTsFiles(dir)
    } catch {
      console.error(`✗ 受检目录不存在：${dir}`)
      console.error('  若目录被重命名，请同步更新本脚本与 .dependency-cruiser.cjs')
      process.exit(1)
    }
    // 防假绿：任一受检目录扫到 0 个文件都不能算通过
    if (found.length === 0) {
      console.error(`✗ ${dir} 下没有 .ts 文件 —— 拒绝以"无违规"通过`)
      process.exit(1)
    }
    files.push(...found)
  }

  // 防假绿第二层：skip 掉 .test.ts 后,若生产文件集合为空,
  // 上面「有文件」的检查就是假的 —— 全部被 skip,等于没扫。
  const prodFiles = files.filter((f) => !f.endsWith('.test.ts'))
  if (prodFiles.length === 0) {
    console.error(
      `✗ ${GUARDED_DIRS.join(' / ')} 下只有测试文件、没有生产 .ts —— ` +
        '全部被 skip,拒绝以"无违规"通过',
    )
    process.exit(1)
  }

  const violations: Violation[] = []

  for (const file of prodFiles) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
    lines.forEach((line, i) => {
      for (const { label, pattern, why } of BANNED) {
        if (pattern.test(line)) {
          violations.push({
            file: relative(process.cwd(), file),
            line: i + 1,
            label,
            why,
            text: line.trim(),
          })
        }
      }
    })
  }

  if (violations.length > 0) {
    console.error(
      `✗ C3 纯度检查失败：${GUARDED_DIRS.join(' / ')} 中发现 ${violations.length} 处禁用全局\n`,
    )
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.label} —— ${v.why}`)
      console.error(`    ${v.text}`)
    }
    console.error('\n转移函数必须是纯函数（ADR-0003）。')
    console.error('副作用只能作为返回值中的描述，由外层执行器实施。')
    process.exit(1)
  }

  console.log(`✓ C3 纯度检查通过（扫描 ${files.length} 个文件，禁用项 ${BANNED.length} 类）`)
}

main()
