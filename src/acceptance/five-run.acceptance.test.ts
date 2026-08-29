/**
 * 五连稳定性战役 —— roadmap §4.1 触发条件 #2。
 *
 * 顺序跑 5 次 `keel run-issue --ci real`，每次新建低风险 Issue。
 * **不在默认 check 中**；整 batch 超时 2.5h。
 *
 * 运行:
 *   export PATH="$HOME/.local/bin:$PATH"
 *   export KEEL_TEST_REMOTE_REPO=https://github.com/jionpz/keel
 *   pnpm vitest run --config vitest.acceptance.config.ts src/acceptance/five-run.acceptance.test.ts
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerRepoMain } from '../cli/register-repo.js'
import { runIssue } from '../cli/run-issue.js'
import { PgArtifactStore } from '../fact/artifact-store.js'
import { asOwner, closePool } from '../fact/db.js'
import { ownerRepo, readTokenFromEnv } from '../fact/github-provider.js'
import {
  appendFiveRunJsonl,
  cleanupAcceptanceRun,
  createLabeledIssue,
  type FiveRunRecord,
  KEEL_LABEL,
  verifyCiOnPr,
} from './gh-issue-helpers.js'
import { preflightGitHub, preflightOmp } from './preflight.js'

const store = new PgArtifactStore()
const token = readTokenFromEnv()
const remote = process.env.KEEL_TEST_REMOTE_REPO

const JSONL_PATH = join(
  process.cwd(),
  '.trellis/tasks/08-29-five-run-campaign/research/five-run-results.jsonl',
)

/** 与 research/issue-templates.md 五变体对齐 */
const ISSUE_BODIES: readonly string[] = [
  [
    '目标:只改 README.md 一处文档,补一句「导出支持按日期筛选」。',
    '约束(必须遵守,写进 RFC.policy_facts):',
    '- risk=low',
    '- complexity=low',
    '- estimated_files=1',
    '- security_sensitive=false',
    '- 禁止改任何 .ts/.sql/.json 代码;禁止新建文件',
    '这是验收探针 run-1,不是架构变更。',
  ].join('\n'),
  [
    '目标:只改 README.md 开发节,补一句「需 Node 24+」。',
    '约束(必须遵守,写进 RFC.policy_facts):',
    '- risk=low',
    '- complexity=low',
    '- estimated_files=1',
    '- security_sensitive=false',
    '- 禁止改任何 .ts/.sql/.json 代码;禁止新建文件',
    '这是验收探针 run-2,不是架构变更。',
  ].join('\n'),
  [
    '目标:只改 README.md,在开发节补一行 test:acceptance 示例。',
    '约束(必须遵守,写进 RFC.policy_facts):',
    '- risk=low',
    '- complexity=low',
    '- estimated_files=1',
    '- security_sensitive=false',
    '- 禁止改任何 .ts/.sql/.json 代码;禁止新建文件',
    '这是验收探针 run-3,不是架构变更。',
  ].join('\n'),
  [
    '目标:只改 README.md,在术语表补「Keel = 编排运行时」一句。',
    '约束(必须遵守,写进 RFC.policy_facts):',
    '- risk=low',
    '- complexity=low',
    '- estimated_files=1',
    '- security_sensitive=false',
    '- 禁止改任何 .ts/.sql/.json 代码;禁止新建文件',
    '这是验收探针 run-4,不是架构变更。',
  ].join('\n'),
  [
    '目标:只改 README.md 状态节,补一句「v0.1 进入环节已闭合」。',
    '约束(必须遵守,写进 RFC.policy_facts):',
    '- risk=low',
    '- complexity=low',
    '- estimated_files=1',
    '- security_sensitive=false',
    '- 禁止改任何 .ts/.sql/.json 代码;禁止新建文件',
    '这是验收探针 run-5,不是架构变更。',
  ].join('\n'),
]

beforeAll(async () => {
  if (token === undefined) {
    throw new Error('缺少 KEEL_GITHUB_TOKEN / GITHUB_TOKEN')
  }
  if (remote === undefined || remote === '') {
    throw new Error('缺少 KEEL_TEST_REMOTE_REPO')
  }
  preflightOmp()
  await preflightGitHub(remote, token)
  writeFileSync(JSONL_PATH, '', 'utf8')
})

afterAll(closePool)

describe('五连稳定性战役(5× run-issue --ci real)', () => {
  it('连续 5 次低风险 Issue 均到 S-DONE 且真实 CI 通过', { timeout: 9_000_000 }, async () => {
    if (remote === undefined) throw new Error('缺少 KEEL_TEST_REMOTE_REPO')
    const slug = ownerRepo(remote)
    expect(slug.ok, slug.ok ? '' : slug.error.detail).toBe(true)
    if (!slug.ok) return

    await registerRepoMain([remote])

    const records: FiveRunRecord[] = []

    for (let run = 1; run <= 5; run += 1) {
      await asOwner((c) =>
        c.query(
          'TRUNCATE artifact, event, task_feedback, run, task, feedback RESTART IDENTITY CASCADE',
        ),
      )

      const stamp = new Date()
        .toISOString()
        .replace(/[^0-9]/g, '')
        .slice(0, 14)
      const body = ISSUE_BODIES[run - 1]
      if (body === undefined) throw new Error(`缺少 run-${run} 模板`)

      const issueUrl = createLabeledIssue(slug.value, `[keel-5run] #${run} ${stamp}`, body)
      const issueNumber = issueUrl.split('/').at(-1) ?? ''

      let taskId: string | undefined
      let prUrl: string | null = null
      const t0 = Date.now()
      let failureClass: string | null = null
      let ciVerified = false
      let finalStatus = ''
      let transitions: string[] = []

      try {
        const result = await runIssue({
          issueUrl,
          label: KEEL_LABEL,
          ci: 'real',
          maxSteps: 30,
          wallClockS: 600,
        })

        if (!result.ok) {
          failureClass = 'infra'
          throw new Error(`run ${run} 失败:${result.error.detail}`)
        }

        taskId = result.value.taskId
        prUrl = result.value.prUrl
        finalStatus = result.value.finalStatus

        const evs = await store.readEvents(taskId, 0, 2000)
        expect(evs.ok).toBe(true)
        if (!evs.ok) return
        transitions = evs.value
          .filter((e) => e.type === 'TaskStatusChanged')
          .map((e) => (e.payload as { transition: string }).transition)

        if (transitions.at(-1) === 'T-031') {
          failureClass = 'timeout'
          throw new Error(`run ${run}: T-031 重试耗尽 —— 不是有效成功`)
        }

        if (finalStatus === 'S-HUMAN_REVIEW') {
          failureClass = 'policy'
          throw new Error(`run ${run}: Policy 人工闸门 —— 五连要求 S-DONE`)
        }

        expect(finalStatus, `run ${run} 应 S-DONE`).toBe('S-DONE')
        expect(prUrl, `run ${run} 应有 PR`).not.toBeNull()
        if (prUrl === null) return

        expect(transitions.at(-1)).toBe('T-024')
        verifyCiOnPr(slug.value, prUrl)
        ciVerified = true
      } finally {
        const duration_s = Math.round((Date.now() - t0) / 1000)
        if (taskId !== undefined) {
          const record: FiveRunRecord = {
            run,
            issue_url: issueUrl,
            task_id: taskId,
            final_status: finalStatus || 'UNKNOWN',
            transitions,
            pr_url: prUrl,
            ci_verified: ciVerified,
            duration_s,
            human_intervention: false,
            failure_class: failureClass,
          }
          records.push(record)
          appendFiveRunJsonl(JSONL_PATH, record)
        }
        cleanupAcceptanceRun({
          remote,
          slug: slug.value,
          taskId,
          prUrl,
          issueNumber,
        })
      }
    }

    expect(records.length, '应记录 5 行 JSONL').toBe(5)
    expect(records.every((r) => r.final_status === 'S-DONE')).toBe(true)
    expect(records.every((r) => r.ci_verified)).toBe(true)

    console.log('\n五连汇总:')
    for (const r of records) {
      console.log(`  #${r.run}: ${r.duration_s}s ${r.transitions.join(' → ')} PR=${r.pr_url}`)
    }
    console.log(`JSONL: ${JSONL_PATH}`)
  })
})
