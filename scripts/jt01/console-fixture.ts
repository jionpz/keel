import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { PoolClient } from 'pg'
import { asOwnerTx, closePool } from '../../src/fact/db.js'
import { branchFor } from '../../src/fact/git-workspace.js'

const DATABASE_PATTERN = /^keel_jt01_console_[a-z0-9_]+$/
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const REQUIRED_TABLES = 'artifact event feedback repo run task task_feedback timer'.split(' ')
const QA_ERROR = 'QA harness 输出无法解析：缺少结构化 verdict'

const PATCH = `diff --git a/src/export/date-range.ts b/src/export/date-range.ts
--- a/src/export/date-range.ts
+++ b/src/export/date-range.ts
@@ -6,3 +6,5 @@
 export function normalize(range: ExportRange): ExportRange {
-  return range
+  const from = range.from ? new Date(range.from).toISOString() : undefined
+  const to = range.to ? new Date(range.to).toISOString() : undefined
+  return { from, to }
 }
`

const RUNS = [
  ['rfc_draft', 'PM', 1, 'SUCCEEDED', 21, 30],
  ['develop', 'Developer', 1, 'SUCCEEDED', 32, 45],
  ['qa', 'QA', 1, 'FAILED', 46, 49],
  ['qa', 'QA', 2, 'FAILED', 49, 52],
  ['qa', 'QA', 3, 'FAILED', 52, 55],
] as const

function fail(message: string): never {
  throw new Error(message)
}

function databaseTarget(): string {
  const raw = process.env.KEEL_DATABASE_URL
  if (raw === undefined || raw === '') {
    fail('KEEL_DATABASE_URL 未设置；本脚本拒绝回退到 DATABASE_URL 或默认 keel_dev')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    fail('KEEL_DATABASE_URL 不是合法 URL')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    fail('KEEL_DATABASE_URL 必须是 postgres:// 或 postgresql://')
  }
  if (url.search !== '' || url.hash !== '') {
    fail('KEEL_DATABASE_URL 不允许 query 或 hash')
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    fail('KEEL_DATABASE_URL 必须指向 localhost')
  }
  const database = url.pathname.replace(/^\//, '')
  if (!DATABASE_PATTERN.test(database)) {
    fail('数据库名必须是 keel_jt01_console_*，且不得使用 keel_dev / keel_test')
  }
  return database
}

function repositoryTarget(): { branch: string; remoteUrl: string } {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const branch = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  if (branch === '' || branch === 'HEAD') {
    fail(`无法确定 ${root} 的基线分支（detached HEAD）；请切到 main 后重试`)
  }
  return { branch, remoteUrl: pathToFileURL(root).href }
}

async function emit(
  c: PoolClient,
  traceId: string,
  taskId: string,
  runId: string | null,
  type: string,
  payload: Record<string, unknown>,
  occurredAt: string,
): Promise<number> {
  const r = await c.query<{ seq: string }>(
    `INSERT INTO event (task_id, run_id, type, payload, trace_id, occurred_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING seq`,
    [taskId, runId, type, JSON.stringify(payload), traceId, occurredAt],
  )
  return Number(r.rows[0]?.seq)
}

async function seed(database: string, repo: { branch: string; remoteUrl: string }): Promise<void> {
  const repoId = randomUUID()
  const feedbackId = randomUUID()
  const taskId = randomUUID()
  const workBranch = branchFor(taskId)
  const sampleRef = `jt01-console:${randomUUID()}`
  const traceId = randomUUID()
  const startedAt = Date.now() - 2 * 60 * 60 * 1000
  const at = (minutes: number): string => new Date(startedAt + minutes * 60 * 1000).toISOString()
  const title = '[JT-01 console] 导出支持按日期区间筛选'
  const humanReviewAt = at(55)

  const result = await asOwnerTx(async (c) => {
    const current = await c.query<{ name: string }>('SELECT current_database() AS name')
    if (current.rows[0]?.name !== database) {
      fail(`连接到的数据库是 ${current.rows[0]?.name ?? '(unknown)'}，不是 ${database}`)
    }
    const missing = await c.query<{ name: string }>(
      `SELECT t.name FROM unnest($1::text[]) AS t(name)
       WHERE to_regclass('public.' || t.name) IS NULL`,
      [REQUIRED_TABLES],
    )
    if (missing.rows.length > 0) {
      fail(`数据库 ${database} 缺少表：${missing.rows.map((r) => r.name).join(', ')}；请先运行迁移`)
    }

    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch) VALUES ($1,'local',$2,$3)`,
      [repoId, repo.remoteUrl, repo.branch],
    )
    await c.query(
      `INSERT INTO feedback (id, source, external_ref, body, received_at) VALUES ($1,'manual',$2,$3,$4)`,
      [
        feedbackId,
        sampleRef,
        '导出 Excel 时希望能按日期区间筛选，避免每次导出全量后手工处理。不传参数时行为必须与现状一致。',
        at(0),
      ],
    )
    await c.query(
      `INSERT INTO task (id, status, control_mode, title, repo_id, base_branch, work_branch,
                         risk, complexity, budget_usd, created_at, updated_at)
       VALUES ($1,'S-HUMAN_REVIEW','auto',$2,$3,$4,$5,'low','medium',5,$6,$7)`,
      [taskId, title, repoId, repo.branch, workBranch, at(0), humanReviewAt],
    )
    await c.query(`INSERT INTO task_feedback (task_id, feedback_id) VALUES ($1,$2)`, [
      taskId,
      feedbackId,
    ])

    const runs = new Map<string, string>()
    for (const [stage, role, attempt, status, start, end] of RUNS) {
      const id = randomUUID()
      const key = `${taskId}/${stage}/${attempt}`
      const failed = status === 'FAILED'
      await c.query(
        `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key,
                          harness_id, harness_tier, started_at, ended_at,
                          tokens_in, tokens_out, cost_usd, cost_basis, error_kind, error_detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'console-fixture','L2',$8,$9,
                 NULL,NULL,NULL,'unavailable',$10,$11)`,
        [
          id,
          taskId,
          stage,
          role,
          attempt,
          status,
          key,
          at(start),
          at(end),
          failed ? 'PROTOCOL_ERROR' : null,
          failed ? QA_ERROR : null,
        ],
      )
      runs.set(`${stage}#${attempt}`, id)
    }
    const rfcRun = runs.get('rfc_draft#1') ?? fail('缺少 rfc_draft#1 run')
    const developRun = runs.get('develop#1') ?? fail('缺少 develop#1 run')
    const qa3 = runs.get('qa#3') ?? fail('缺少 qa#3 run')

    const rfc = {
      schema_version: '1.0',
      title: 'Excel 导出支持日期区间筛选',
      problem: '企业用户导出全量数据后需要在 Excel 中手工筛选日期，数据量大时不可用。',
      goals: ['导出接口支持 date_from / date_to 参数', '日期区间按闭区间过滤'],
      non_goals: ['不改动导出文件格式', '不增加日期以外的筛选维度'],
      proposed_change: {
        summary: '在导出参数归一化层增加可选日期区间，查询层按区间过滤。',
        affected_areas: ['src/export/date-range.ts', 'src/export/service.ts'],
        approach: '新增可选参数，缺省行为保持不变，保证向后兼容。',
      },
      alternatives_considered: [
        {
          id: 'B',
          summary: '新建独立导出服务',
          why_not: '改动范围远超需求，现有导出链路已能复用。',
        },
      ],
      acceptance_criteria: [
        { id: 'AC1', text: '传入日期参数时只导出区间内数据。', verifiable_by: '集成测试' },
        { id: 'AC2', text: '不传日期参数时结果与改动前一致。', verifiable_by: '回归测试' },
      ],
      test_plan: ['为 AC1 / AC2 增加集成与回归用例', '补充空区间与反序区间边界用例'],
      rollback_plan: '参数为可选且缺省行为不变，回滚只需 revert 单个提交。',
      policy_facts: {
        risk: 'low',
        complexity: 'medium',
        estimated_files_changed: 1,
        security_related: false,
      },
    }
    const artifactSeq = await emit(
      c,
      traceId,
      taskId,
      rfcRun,
      'ArtifactCommitted',
      { kind: 'rfc', key: '', version: 1 },
      at(30),
    )
    await c.query(
      `INSERT INTO artifact (id, task_id, kind, key, version, schema_version, body,
                             produced_by_run, committed_at, committed_at_seq)
       VALUES ($1,$2,'rfc','',1,'1.0',$3::jsonb,$4,$5,$6)`,
      [randomUUID(), taskId, JSON.stringify(rfc), rfcRun, at(30), artifactSeq],
    )
    await emit(
      c,
      traceId,
      taskId,
      developRun,
      'WorkspaceDiffCollected',
      {
        stage: 'develop',
        attempt: 1,
        collected: true,
        collect_error: null,
        files_changed: [{ path: 'src/export/date-range.ts', change: 'modified' }],
        commits: [],
        is_dirty: true,
        patch: PATCH,
        patch_chars: PATCH.length,
        patch_truncated: false,
      },
      at(45),
    )
    await emit(
      c,
      traceId,
      taskId,
      qa3,
      'TaskStatusChanged',
      { from: 'S-QA', to: 'S-HUMAN_REVIEW', transition: 'T-031', event: 'RunFailed' },
      humanReviewAt,
    )
    await c.query(
      `INSERT INTO timer (id, task_id, run_id, kind, due_at, state)
       VALUES ($1,$2,NULL,'human_review_ttl',$3,'pending')`,
      [
        randomUUID(),
        taskId,
        new Date(new Date(humanReviewAt).getTime() + 24 * 60 * 60 * 1000).toISOString(),
      ],
    )

    return { taskId, repoId, workBranch, sampleRef }
  })

  console.log(`task_id=${result.taskId}`)
  console.log(`repo_id=${result.repoId}`)
  console.log(`work_branch=${result.workBranch}`)
  console.log(`sample_ref=${result.sampleRef}`)
  console.log('未 TRUNCATE 或修改任何已有行；重复执行会新增另一个带唯一 external_ref 的样本。')
}

async function main(): Promise<void> {
  const database = databaseTarget()
  const repo = repositoryTarget()
  console.log(`database=${database}`)
  console.log(`source_repo=${repo.remoteUrl}`)
  await seed(database, repo)
}

main()
  .then(() => closePool())
  .catch(async (e) => {
    console.error(`console-fixture: ${e instanceof Error ? e.message : String(e)}`)
    await closePool().catch(() => undefined)
    process.exitCode = 1
  })
