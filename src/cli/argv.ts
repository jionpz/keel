/**
 * CLI argv 解析 —— 零依赖手写(issue #27)。
 *
 * 支持:
 *   --flag           布尔(值 true)
 *   --flag value     字符串/数字值
 *   位置参数(无 -- 前缀)
 */

export interface ParsedArgs {
  readonly positionals: readonly string[]
  readonly flags: Readonly<Record<string, string | number | boolean>>
}

/** 解析底层 argv(不含 command)。--flag value 形式;未知 -- 即报错 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | number | boolean> = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--help' || arg === '-h') {
      flags.help = true
      continue
    }
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const next = argv[i + 1]
      // 布尔:无下一个 token 或下一个也是 --;否则取值
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true
      } else {
        flags[name] = parseValue(next)
        i++
      }
      continue
    }
    positionals.push(arg)
  }

  return { positionals, flags }
}

function parseValue(raw: string): string | number {
  const n = Number(raw)
  return raw !== '' && Number.isFinite(n) ? n : raw
}
