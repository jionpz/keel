/**
 * `post_validate` 路径的 JSON 提取 —— 纯函数。
 *
 * OMP 无 `CAP-STRUCTURED_OUTPUT`（实测确认），因此提案只能从自由文本里提取。
 * 见 docs/05-contracts/harness-adapter.md §2 的降级矩阵。
 *
 * **不用正则暴力匹配**：正则在嵌套 JSON 上会悄悄取错，
 * 而取错的后果是「校验通过但内容是错的」—— 比提取失败更糟。
 * 这里用平衡括号扫描。
 */

export type ExtractResult =
  | { readonly ok: true; readonly value: unknown; readonly strategy: ExtractStrategy }
  | { readonly ok: false; readonly reason: string }

export type ExtractStrategy = 'json-fence' | 'any-fence' | 'balanced-scan'

/** 按优先级尝试三种策略 */
export function extractJson(text: string): ExtractResult {
  for (const [strategy, candidate] of candidates(text)) {
    const parsed = tryParse(candidate)
    if (parsed !== undefined) return { ok: true, value: parsed, strategy }
  }
  return {
    ok: false,
    reason: '未能从输出中提取 JSON（已尝试 ```json 围栏、任意围栏、平衡括号扫描）',
  }
}

function* candidates(text: string): Generator<[ExtractStrategy, string]> {
  const jsonFence = matchFence(text, true)
  if (jsonFence !== null) yield ['json-fence', jsonFence]

  const anyFence = matchFence(text, false)
  if (anyFence !== null) yield ['any-fence', anyFence]

  const scanned = balancedObject(text)
  if (scanned !== null) yield ['balanced-scan', scanned]
}

/** 取围栏内容。`jsonOnly` 时只认 ```json */
function matchFence(text: string, jsonOnly: boolean): string | null {
  const re = jsonOnly ? /```json\s*\n([\s\S]*?)```/i : /```[a-z]*\s*\n([\s\S]*?)```/i
  const m = re.exec(text)
  return m?.[1] ?? null
}

/**
 * 从首个 `{` 起做平衡括号扫描，返回第一个完整的对象。
 *
 * 跳过字符串字面量内的括号与转义字符 —— 否则 `{"a":"}"}` 会被截错。
 */
function balancedObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string

    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s.trim())
  } catch {
    return undefined
  }
}
