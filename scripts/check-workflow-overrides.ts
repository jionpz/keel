/**
 * workflow-overrides 一致性检查：确认 Trellis 的工作流里**没有**固定的批准闸。
 *
 * 背景：workflow.md 与各平台 skill 副本原先在建任务前、`task.py start` 前各停一次
 *   要人批准。现在只剩三类必停（见 Request Triage），而这一行为分散在四套平台副本里
 *   —— `.claude` / `.agents` / `.omp` / `.dsh`。其中五份登记在
 *   `.trellis/.template-hashes.json`，跑一次 `trellis update` 就会把它们覆盖回旧版，
 *   行为静默退回「问两次」，而没有任何东西会报警。
 *
 * 本检查**比对，而不是生成**。
 * 理由：文档/skill 的正文无法从某个源可靠地生成；生成失败会悄悄产出错的内容，
 *       比对失败只是报警 —— **前者的失效模式更危险**。
 *       与 scripts/check-transition-table.ts 同一取舍。
 *
 * 三类断言：
 *   1. 判据锚点存在 —— 防止整段被模板重写后「看起来还挺对」。
 *   2. 旧 gate 措辞不存在 —— 防止部分回退（锚点在、但旁边又冒出旧流程）。
 *   3. 平台镜像逐字节一致 —— 防止只改了一个平台，另外三个 harness 没生效。
 *
 * 防假绿：一个锚点都没找到时单独报错。否则「文件整体被替换成空/别的模板」
 *   会伪装成「没有旧措辞」而通过。
 *
 * 注意：不要扫描 `.trellis/spec/guides/cross-layer-thinking-guide.md`。
 *   其中出现 `task-creation consent` 是在记录一次历史事故（beta 文档污染），
 *   改掉它等于篡改记录。`workflow-overrides.md` 自身也含旧措辞（作为检索样例），
 *   同样不扫。
 */

import { readFileSync } from 'node:fs'

/** 判据锚点：旧版模板里不存在这些句子，所以缺一条就说明被覆盖过 */
const REQUIRED_ANCHORS: Array<{ path: string; anchors: string[] }> = [
  {
    path: '.trellis/workflow.md',
    anchors: ['three blocking cases', 'Do not ask whether a task should be created'],
  },
  {
    path: '.claude/skills/trellis-brainstorm/SKILL.md',
    anchors: ['three blocking cases', 'No separate consent step is needed'],
  },
  {
    path: '.agents/skills/trellis-brainstorm/SKILL.md',
    anchors: ['three blocking cases', 'No separate consent step is needed'],
  },
  {
    path: '.omp/skills/trellis-brainstorm/SKILL.md',
    anchors: ['three blocking cases', 'No separate consent step is needed'],
  },
]

/**
 * 旧 gate 措辞。按大小写不敏感匹配 —— 这些是英文句子，大小写回退同样说明
 * 有人把旧版内容贴了回来。
 */
const STALE_PHRASES: string[] = [
  'task-creation consent',
  'explicitly approved',
  'after user confirms',
  'must respond at least once',
  'reviewed before start',
  '1.4** review',
  'ask for start review',
]

/** 参与旧措辞扫描的文件（各 harness 实际驱动行为的那一份） */
const DRIVING_FILES: string[] = [
  '.trellis/workflow.md',
  '.claude/skills/trellis-brainstorm/SKILL.md',
  '.agents/skills/trellis-brainstorm/SKILL.md',
  '.omp/skills/trellis-brainstorm/SKILL.md',
  '.claude/commands/trellis/continue.md',
  '.agents/skills/source-command-trellis-continue/SKILL.md',
  '.omp/commands/trellis-continue.md',
  '.dsh/skills/trellis-continue/SKILL.md',
  // 不在 R2 的八个里，但同样被 trellis update 覆盖，漏扫没道理
  '.claude/skills/trellis-meta/references/customize-local/change-workflow.md',
  '.agents/skills/trellis-meta/references/customize-local/change-workflow.md',
  '.omp/skills/trellis-meta/references/customize-local/change-workflow.md',
]

/**
 * 必须逐字节一致的镜像组。
 *
 * 只收**不含平台封装**的文件：`.omp/commands/trellis-continue.md` 与
 * `.dsh/skills/trellis-continue/SKILL.md` 带 frontmatter / `--platform` 参数，
 * 本来就与 `.claude` 版不同 —— 它们只参与旧措辞扫描。
 */
const MIRROR_GROUPS: Array<{ name: string; files: string[] }> = [
  {
    name: 'trellis-brainstorm',
    files: [
      '.claude/skills/trellis-brainstorm/SKILL.md',
      '.agents/skills/trellis-brainstorm/SKILL.md',
      '.omp/skills/trellis-brainstorm/SKILL.md',
    ],
  },
  {
    name: 'change-workflow',
    files: [
      '.claude/skills/trellis-meta/references/customize-local/change-workflow.md',
      '.agents/skills/trellis-meta/references/customize-local/change-workflow.md',
      '.omp/skills/trellis-meta/references/customize-local/change-workflow.md',
    ],
  },
]

const OVERRIDES_DOC = '.trellis/spec/guides/workflow-overrides.md'

/** 读不到就记一笔问题，不静默跳过（R5） */
function readOrFail(path: string, problems: string[]): string | null {
  try {
    const text = readFileSync(path, 'utf8')
    if (text.trim() === '') {
      problems.push(`  ${path}  文件为空 —— 内容像是丢了`)
      return null
    }
    return text
  } catch {
    problems.push(`  ${path}  文件缺失或不可读`)
    return null
  }
}

/** 返回命中行号（1 起），大小写不敏感 */
function findPhrase(text: string, phrase: string): number[] {
  const needle = phrase.toLowerCase()
  const hits: number[] = []
  for (const [i, line] of text.split('\n').entries()) {
    if (line.toLowerCase().includes(needle)) hits.push(i + 1)
  }
  return hits
}

function main(): void {
  const problems: string[] = []

  // ---- 1. 判据锚点存在 ----
  let anchorsFound = 0
  let anchorFilesRead = 0
  for (const { path, anchors } of REQUIRED_ANCHORS) {
    const text = readOrFail(path, problems)
    if (text === null) continue
    anchorFilesRead++
    const lower = text.toLowerCase()
    for (const anchor of anchors) {
      if (lower.includes(anchor.toLowerCase())) {
        anchorsFound++
      } else {
        problems.push(`  ${path}  缺少判据锚点 "${anchor}"`)
      }
    }
  }

  // ---- 2. 旧 gate 措辞不存在 ----
  for (const path of DRIVING_FILES) {
    const text = readOrFail(path, problems)
    if (text === null) continue
    for (const phrase of STALE_PHRASES) {
      for (const line of findPhrase(text, phrase)) {
        problems.push(`  ${path}:${line}  出现旧 gate 措辞 "${phrase}"`)
      }
    }
  }

  // ---- 3. 平台镜像逐字节一致 ----
  for (const group of MIRROR_GROUPS) {
    const base = group.files[0]
    if (base === undefined) continue
    const baseText = readOrFail(base, problems)
    if (baseText === null) continue
    for (const other of group.files.slice(1)) {
      const otherText = readOrFail(other, problems)
      if (otherText === null) continue
      if (otherText !== baseText) {
        problems.push(`  ${other}  与 ${base} 不一致（镜像组 ${group.name}）`)
      }
    }
  }

  // ---- 防假绿 ----
  // 文件读到了、但一条锚点都没有：说明内容被整体换成了别的模板。
  // 此时「没有旧措辞」不构成通过的理由。
  // 文件读不到的情况不在这里处理 —— 那几条问题已经足够说明，交给下面的汇总报。
  if (anchorFilesRead > 0 && anchorsFound === 0) {
    console.error('✗ workflow-overrides 检查：一个判据锚点都没找到 —— 拒绝以"无问题"通过')
    console.error('  workflow.md 或三份 brainstorm 可能被整体替换成了旧模板。')
    console.error(`  规则与判据见 ${OVERRIDES_DOC}`)
    process.exit(1)
  }

  if (problems.length > 0) {
    console.error(`✗ workflow-overrides 检查失败（${problems.length} 处）\n`)
    for (const p of problems) console.error(p)
    console.error(
      '\n改动工作流后，四套平台副本必须同步（`.claude` / `.agents` / `.omp` / `.dsh`）。',
    )
    console.error('若刚跑过 `trellis update`，多半是它把文件覆盖回了旧模板：')
    console.error(`  规则与修复步骤：${OVERRIDES_DOC}`)
    console.error('  手工自检命令同在该页「自检」一节')
    process.exit(1)
  }

  const mirrorCount = MIRROR_GROUPS.reduce((n, g) => n + g.files.length, 0)
  console.log(
    `✓ workflow-overrides 一致（${anchorsFound} 条判据锚点 / ${DRIVING_FILES.length} 个文件无旧 gate 措辞 / ${mirrorCount} 份镜像逐字节相同）`,
  )
}

main()
