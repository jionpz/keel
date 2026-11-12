/**
 * JT-06 一致性备份与隔离恢复校验。
 *
 * 设计边界：
 *   - PostgreSQL 一致性快照 + `pg_dump --snapshot`；blob 是内容寻址、写入后不可变，
 *     所以 dump 之后复制被引用的 blob 仍然对应同一个逻辑快照；
 *   - manifest 记录 DB dump、blob、工作流包摘要、队列/外部关联；
 *   - restore-verify 只在隔离数据库恢复并核对摘要，不重放外部动作、不自动重试；
 *   - 缺外部凭据时明确标记阻塞，不能把“数据恢复成功”说成“服务已恢复”。
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { Client } from 'pg'
import { blobRoot, hashOf } from '../../fact/blob.js'
import { connectionString } from '../../fact/db.js'
import { resolveGitHubToken } from '../../fact/github-auth.js'
import { sha256CanonicalJson } from '../../shared/canonical-json.js'
import { routePackageDigest, validateRoutePackage } from '../managed/route-protocol.js'
import { ticketPackageDigest, validateTicketPackage } from '../managed/ticket-protocol.js'

const HASH = /^[a-f0-9]{64}$/
const DATABASE_FILE = 'database.dump'
const MANIFEST_FILE = 'manifest.json'
const MANIFEST_HASH_FILE = 'manifest.sha256'
const BLOB_DIR = 'blobs'

export interface BackupFileRecord {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
}

export interface BackupBlobRecord extends BackupFileRecord {
  readonly hash: string
}

export interface BackupPackageRecord {
  readonly digest: string
  readonly body_sha256: string
}

export interface ExternalReference {
  readonly kind: string
  readonly id: string
  readonly ref: string | null
  readonly status: string | null
  readonly remote_url: string | null
}

export interface BackupDatabaseSummary {
  readonly counts: Readonly<Record<string, number>>
  readonly queues: Readonly<Record<string, Readonly<Record<string, number>>>>
  readonly pending: {
    readonly questions: number
    readonly decisions: number
    readonly tickets: number
    readonly workflows: number
    readonly outbox: number
  }
  readonly packages: readonly BackupPackageRecord[]
  readonly blob_refs: readonly string[]
  readonly external_refs: readonly ExternalReference[]
}

export interface BackupManifest {
  readonly format: 'keel-backup/v1'
  readonly created_at: string
  readonly database: BackupFileRecord
  readonly blobs: {
    readonly root: string
    readonly files: readonly BackupBlobRecord[]
    readonly count: number
    readonly bytes: number
  }
  readonly summary: BackupDatabaseSummary
}

export interface RestoreCheck {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

export interface RestoreReport {
  readonly format: 'keel-restore-verify/v1'
  readonly database_name: string
  readonly backup: string
  readonly status: 'VERIFIED' | 'FAILED'
  readonly checks: readonly RestoreCheck[]
  readonly resume: {
    readonly status: 'READY' | 'WAITING_HUMAN' | 'BLOCKED_UNTIL_RECONCILE' | 'BLOCKED_CREDENTIALS'
    readonly reason: string
    readonly github_credential: boolean
  }
}

export interface BackupOptions {
  readonly outputDir: string
  readonly databaseUrl?: string
  readonly blobDir?: string
  readonly now?: string
}

export interface RestoreVerifyOptions {
  readonly backupDir: string
  readonly databaseUrl?: string
  readonly now?: string
  readonly keepDatabase?: boolean
  /** 测试注入；缺省走统一的 env → gh auth 凭据链。 */
  readonly credentialAvailable?: () => Promise<boolean>
}

type CommandRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<void>

export const defaultCommandRunner: CommandRunner = (command, args, env) =>
  new Promise((resolveCommand, reject) => {
    execFile(command, [...args], { env, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error === null) {
        resolveCommand()
        return
      }
      const detail = redact(
        [error.message, String(stderr ?? '').trim()].filter((item) => item !== '').join('\n'),
      )
      reject(new Error(`${command} 失败：${detail}`))
    })
  })

function redact(value: string): string {
  return value.replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, 'postgres://***')
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function positiveCount(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  throw new Error(`manifest 计数非法：${String(value)}`)
}

function relativeSafe(path: string): boolean {
  if (path === '' || isAbsolute(path) || path.includes('\\')) return false
  const normalized = normalize(path)
  return normalized === path && !normalized.startsWith(`..${sep}`) && normalized !== '..'
}

function assertHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`${label} 不是 SHA256`)
  return value
}

function parsePostgresUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('备份只支持 postgres:// URL 形式，拒绝把连接串放进子进程 argv')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    throw new Error(`不支持的数据库协议：${url.protocol}`)
  return url
}

/** 把连接串拆成 libpq 环境变量，避免密码出现在子进程参数列表。 */
export function pgEnvironment(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const url = parsePostgresUrl(databaseUrl)
  const result: NodeJS.ProcessEnv = { ...env }
  if (url.hostname !== '') result.PGHOST = decodeURIComponent(url.hostname)
  if (url.port !== '') result.PGPORT = url.port
  if (url.username !== '') result.PGUSER = decodeURIComponent(url.username)
  if (url.password !== '') result.PGPASSWORD = decodeURIComponent(url.password)
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  if (database !== '') result.PGDATABASE = database
  const sslmode = url.searchParams.get('sslmode')
  if (sslmode !== null) result.PGSSLMODE = sslmode
  delete result.PGSERVICE
  return result
}

function databaseName(databaseUrl: string): string {
  const url = parsePostgresUrl(databaseUrl)
  const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  if (name === '') throw new Error('数据库 URL 缺少数据库名')
  return name
}

function withDatabase(databaseUrl: string, name: string): string {
  const url = parsePostgresUrl(databaseUrl)
  url.pathname = `/${encodeURIComponent(name)}`
  return url.toString()
}

function blobPath(root: string, hash: string): string {
  assertHash(hash, 'blob hash')
  return join(root, hash.slice(0, 2), hash.slice(2))
}

function collectBlobRefs(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectBlobRefs(item, refs)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const record = value as Record<string, unknown>
  const ref = record.$ref
  if (typeof ref === 'string' && ref.startsWith('blob://')) {
    const hash = ref.slice('blob://'.length)
    if (!HASH.test(hash)) throw new Error('数据库包含非法 blob 引用')
    refs.add(hash)
  }
  for (const item of Object.values(record)) collectBlobRefs(item, refs)
}

async function relationCount(client: Client, table: string): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table}`,
  )
  return Number(result.rows[0]?.count ?? 0)
}

async function statusCounts(
  client: Client,
  table: string,
): Promise<Readonly<Record<string, number>>> {
  const result = await client.query<{ status: string; count: number }>(
    `SELECT status,count(*)::int AS count FROM ${table} GROUP BY status ORDER BY status`,
  )
  return Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count)]))
}

async function scalar(client: Client, sql: string, params: unknown[] = []): Promise<number> {
  const result = await client.query<{ count: number }>(sql, params)
  return Number(result.rows[0]?.count ?? 0)
}

/**
 * 在调用方已经开启的 REPEATABLE READ 事务中读取备份摘要。
 * 返回的 package body hash 必须与 digest 一致；不一致说明事实已损坏，备份 fail-closed。
 */
export async function readBackupSummary(client: Client): Promise<BackupDatabaseSummary> {
  const counts: Record<string, number> = {}
  for (const table of [
    'repo',
    'managed_package',
    'managed_task',
    'managed_question',
    'managed_attempt',
    'managed_ticket_task',
    'managed_ticket_stage',
    'managed_ticket_event',
    'managed_workflow',
    'managed_workflow_node',
    'managed_workflow_evidence',
    'managed_workflow_event',
    'managed_decision_request',
    'managed_decision_resolution',
    'managed_project_decision',
    'managed_delegation_policy',
    'managed_action_intent',
    'managed_action_outbox',
    'managed_check_target',
    'managed_check_observation',
    'artifact',
    'event',
  ])
    counts[table] = await relationCount(client, table)

  const queues = {
    tickets: await statusCounts(client, 'managed_ticket_task'),
    workflows: await statusCounts(client, 'managed_workflow'),
    workflow_nodes: await statusCounts(client, 'managed_workflow_node'),
    decisions: await statusCounts(client, 'managed_decision_request'),
    outbox: await statusCounts(client, 'managed_action_outbox'),
    checks: await statusCounts(client, 'managed_check_target'),
  }
  const pending = {
    questions: await scalar(
      client,
      `SELECT count(*)::int AS count FROM managed_question WHERE status <> 'RESOLVED'`,
    ),
    decisions: await scalar(
      client,
      `SELECT count(*)::int AS count FROM managed_decision_request
       WHERE status IN ('OPEN','PROCESSING','WAITING_HUMAN')`,
    ),
    tickets: await scalar(
      client,
      `SELECT count(*)::int AS count FROM managed_ticket_task
       WHERE status IN ('READY','RUNNING','WAITING_HUMAN','WAITING_GATEWAY','PAUSED')`,
    ),
    workflows: await scalar(
      client,
      `SELECT count(*)::int AS count FROM managed_workflow
       WHERE status NOT IN ('DONE','FAILED','CANCELLED')`,
    ),
    outbox: await scalar(
      client,
      `SELECT count(*)::int AS count FROM managed_action_outbox
       WHERE status IN ('PENDING','LEASED','EXECUTING','UNCERTAIN','BLOCKED')`,
    ),
  }

  const packageRows = await client.query<{ digest: string; body: unknown }>(
    'SELECT digest,body FROM managed_package ORDER BY digest',
  )
  const packages = packageRows.rows.map((row) => {
    const bodySha = sha256CanonicalJson(row.body)
    const mode =
      typeof row.body === 'object' && row.body !== null && 'mode' in row.body
        ? row.body.mode
        : undefined
    let digest = bodySha
    if (mode === 'ticket') {
      const validated = validateTicketPackage(row.body)
      if (!validated.ok) throw new Error(`managed_package ${row.digest} 内容摘要不一致`)
      digest = ticketPackageDigest(validated.value.package)
    } else if (mode === 'route') {
      const validated = validateRoutePackage(row.body)
      if (!validated.ok) throw new Error(`managed_package ${row.digest} 内容摘要不一致`)
      digest = routePackageDigest(validated.value.package)
    }
    if (digest !== row.digest) throw new Error(`managed_package ${row.digest} 内容摘要不一致`)
    return { digest: row.digest, body_sha256: bodySha }
  })

  const blobRefs = new Set<string>()
  const artifactRows = await client.query<{ body: unknown }>('SELECT body FROM artifact')
  for (const row of artifactRows.rows) collectBlobRefs(row.body, blobRefs)
  const stageRows = await client.query<{ result: unknown; evidence: unknown }>(
    'SELECT result,evidence FROM managed_ticket_stage',
  )
  for (const row of stageRows.rows) {
    collectBlobRefs(row.result, blobRefs)
    collectBlobRefs(row.evidence, blobRefs)
  }
  const workflowEvidenceRows = await client.query<{ result: unknown; evidence: unknown }>(
    'SELECT result,evidence FROM managed_workflow_evidence',
  )
  for (const row of workflowEvidenceRows.rows) {
    collectBlobRefs(row.result, blobRefs)
    collectBlobRefs(row.evidence, blobRefs)
  }

  const externalResult = await client.query<ExternalReference>(
    `SELECT 'workflow'::text AS kind, id::text AS id, external_issue AS ref,
            status, NULL::text AS remote_url
       FROM managed_workflow WHERE external_issue IS NOT NULL
     UNION ALL
     SELECT 'workflow_node'::text, id::text, external_issue, status, NULL::text
       FROM managed_workflow_node WHERE external_issue IS NOT NULL
     UNION ALL
     SELECT 'issue_claim'::text, id::text, issue_ref, status, NULL::text
       FROM managed_issue_claim
     UNION ALL
     SELECT 'action_outbox'::text, id::text, remote_id, status, remote_url
       FROM managed_action_outbox
     ORDER BY kind,id`,
  )

  return {
    counts,
    queues,
    pending,
    packages,
    blob_refs: [...blobRefs].sort(),
    external_refs: externalResult.rows,
  }
}

async function captureBlobs(
  refs: readonly string[],
  sourceRoot: string,
  targetRoot: string,
): Promise<{ files: BackupBlobRecord[]; count: number; bytes: number }> {
  const files: BackupBlobRecord[] = []
  for (const hash of refs) {
    const source = blobPath(sourceRoot, hash)
    const data = await readFile(source)
    const actual = hashOf(data)
    if (actual !== hash) throw new Error(`blob ${hash} 内容摘要不一致`)
    const relative = `${BLOB_DIR}/${hash.slice(0, 2)}/${hash.slice(2)}`
    const target = join(targetRoot, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, data)
    files.push({ hash, path: relative, sha256: actual, bytes: data.byteLength })
  }
  return {
    files,
    count: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
  }
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const data = await readFile(path)
  return { sha256: sha256(data), bytes: data.byteLength }
}

export async function createBackup(
  options: BackupOptions,
  runner: CommandRunner = defaultCommandRunner,
): Promise<BackupManifest> {
  const databaseUrl = options.databaseUrl ?? connectionString()
  const blobDir = options.blobDir ?? blobRoot()
  const outputDir = resolve(options.outputDir)
  try {
    await stat(outputDir)
    throw new Error(`备份目录已存在，拒绝覆盖：${outputDir}`)
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    )
      throw error
  }
  const parent = dirname(outputDir)
  await mkdir(parent, { recursive: true })
  const temporary = join(parent, `.${outputDir.split(sep).at(-1)}.tmp-${process.pid}-${Date.now()}`)
  await mkdir(temporary, { recursive: false })
  const client = new Client({ connectionString: databaseUrl })
  try {
    await client.connect()
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query('SET LOCAL ROLE keel_control')
    const snapshotResult = await client.query<{ snapshot: string }>(
      'SELECT pg_export_snapshot() AS snapshot',
    )
    const snapshot = snapshotResult.rows[0]?.snapshot
    if (snapshot === undefined) throw new Error('PostgreSQL 未返回 exported snapshot')
    const dumpPath = join(temporary, DATABASE_FILE)
    await runner(
      'pg_dump',
      ['--format=custom', '--no-owner', '--snapshot', snapshot, '--file', dumpPath],
      pgEnvironment(databaseUrl),
    )
    const summary = await readBackupSummary(client)
    await client.query('COMMIT')
    const blobs = await captureBlobs(summary.blob_refs, blobDir, temporary)
    const dump = await hashFile(dumpPath)
    const manifest: BackupManifest = {
      format: 'keel-backup/v1',
      created_at: options.now ?? new Date().toISOString(),
      database: { path: DATABASE_FILE, sha256: dump.sha256, bytes: dump.bytes },
      blobs: { root: BLOB_DIR, ...blobs },
      summary,
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await writeFile(join(temporary, MANIFEST_FILE), manifestBytes)
    await writeFile(join(temporary, MANIFEST_HASH_FILE), `${sha256(manifestBytes)}\n`)
    await rename(temporary, outputDir)
    return manifest
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    await client.end().catch(() => undefined)
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    throw error
  } finally {
    await client.end().catch(() => undefined)
  }
}

export async function verifyBackupDirectory(directory: string): Promise<BackupManifest> {
  const base = resolve(directory)
  const manifestBytes = await readFile(join(base, MANIFEST_FILE))
  const expectedHash = (await readFile(join(base, MANIFEST_HASH_FILE), 'utf8')).trim()
  if (!HASH.test(expectedHash) || sha256(manifestBytes) !== expectedHash)
    throw new Error('manifest.sha256 不匹配')
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestBytes.toString('utf8'))
  } catch {
    throw new Error('manifest.json 不是合法 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('manifest 不是对象')
  const manifest = parsed as BackupManifest
  if (manifest.format !== 'keel-backup/v1') throw new Error('未知备份格式')
  if (!relativeSafe(manifest.database.path)) throw new Error('数据库备份路径越界')
  const databasePath = join(base, manifest.database.path)
  const database = await hashFile(databasePath)
  if (database.sha256 !== assertHash(manifest.database.sha256, 'database.sha256'))
    throw new Error('数据库备份摘要不一致')
  if (database.bytes !== positiveCount(manifest.database.bytes))
    throw new Error('数据库备份大小不一致')
  if (manifest.blobs.root !== BLOB_DIR) throw new Error('blob 根目录非法')
  if (!Array.isArray(manifest.blobs.files)) throw new Error('blob 清单非法')
  for (const blob of manifest.blobs.files) {
    assertHash(blob.hash, 'blob.hash')
    assertHash(blob.sha256, 'blob.sha256')
    if (!relativeSafe(blob.path) || !blob.path.startsWith(`${BLOB_DIR}/`))
      throw new Error('blob 路径越界')
    const data = await readFile(join(base, blob.path))
    if (data.byteLength !== positiveCount(blob.bytes))
      throw new Error(`blob ${blob.hash} 大小不一致`)
    if (sha256(data) !== blob.sha256 || hashOf(data) !== blob.hash)
      throw new Error(`blob ${blob.hash} 摘要不一致`)
  }
  if (positiveCount(manifest.blobs.count) !== manifest.blobs.files.length)
    throw new Error('blob count 与清单不一致')
  if (positiveCount(manifest.blobs.bytes) !== manifest.blobs.files.reduce((n, f) => n + f.bytes, 0))
    throw new Error('blob 总大小与清单不一致')
  return manifest
}

function compareSummaries(
  expected: BackupDatabaseSummary,
  actual: BackupDatabaseSummary,
): readonly RestoreCheck[] {
  const checks: RestoreCheck[] = []
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail })
  }
  check(
    'counts',
    JSON.stringify(expected.counts) === JSON.stringify(actual.counts),
    `${JSON.stringify(actual.counts)}`,
  )
  check(
    'queues',
    JSON.stringify(expected.queues) === JSON.stringify(actual.queues),
    `${JSON.stringify(actual.queues)}`,
  )
  check(
    'pending',
    JSON.stringify(expected.pending) === JSON.stringify(actual.pending),
    `${JSON.stringify(actual.pending)}`,
  )
  check(
    'packages',
    JSON.stringify(expected.packages) === JSON.stringify(actual.packages),
    `${actual.packages.length} packages`,
  )
  check(
    'blob_refs',
    JSON.stringify(expected.blob_refs) === JSON.stringify(actual.blob_refs),
    `${actual.blob_refs.length} refs`,
  )
  check(
    'external_refs',
    JSON.stringify(expected.external_refs) === JSON.stringify(actual.external_refs),
    `${actual.external_refs.length} refs`,
  )
  return checks
}

async function resumeDecision(
  summary: BackupDatabaseSummary,
  credentialAvailable: () => Promise<boolean>,
): Promise<RestoreReport['resume']> {
  const outbox = summary.queues.outbox ?? {}
  const external =
    (outbox.PENDING ?? 0) +
      (outbox.LEASED ?? 0) +
      (outbox.EXECUTING ?? 0) +
      (outbox.UNCERTAIN ?? 0) +
      (outbox.BLOCKED ?? 0) >
    0
  // 没有外部动作时不调用凭据探测，避免只读恢复校验触发 gh 子进程。
  const githubCredential = external ? await credentialAvailable() : false
  if ((outbox.UNCERTAIN ?? 0) > 0 || (outbox.EXECUTING ?? 0) > 0)
    return {
      status: 'BLOCKED_UNTIL_RECONCILE',
      reason: '存在 EXECUTING/UNCERTAIN 外部动作，恢复后必须先回查远端对象',
      github_credential: githubCredential,
    }
  if (external && !githubCredential)
    return {
      status: 'BLOCKED_CREDENTIALS',
      reason: '存在待恢复外部动作，但缺少 GitHub 凭据；服务不得认领这些动作',
      github_credential: false,
    }
  if (summary.pending.questions > 0 || summary.pending.decisions > 0)
    return {
      status: 'WAITING_HUMAN',
      reason: '数据已恢复；仍有待答问题，服务可恢复等待但不能伪造答复',
      github_credential: githubCredential,
    }
  return {
    status: 'READY',
    reason: '数据摘要与队列已校验；启动前仍需通过 harness/凭据预检',
    github_credential: githubCredential,
  }
}

/**
 * 在隔离数据库恢复并核对；成功后默认删除临时库，失败则保留现场。
 * 显式 `keepDatabase: true` 可保留成功演练的证据库。
 */
export async function restoreVerify(
  options: RestoreVerifyOptions,
  runner: CommandRunner = defaultCommandRunner,
): Promise<RestoreReport> {
  const backup = await verifyBackupDirectory(options.backupDir)
  const databaseUrl = options.databaseUrl ?? connectionString()
  const sourceName = databaseName(databaseUrl)
  const credentialAvailable =
    options.credentialAvailable ??
    (async () => {
      try {
        return (await resolveGitHubToken()) !== undefined
      } catch {
        return false
      }
    })
  const target = `keel_restore_${Date.now()}_${process.pid}`
  if (target === sourceName) throw new Error('恢复目标不能与源库同名')
  const env = { ...pgEnvironment(databaseUrl), PGDATABASE: 'postgres' }
  await runner('createdb', ['--maintenance-db=postgres', target], env)
  let verified: BackupDatabaseSummary | undefined
  let checks: readonly RestoreCheck[] = []
  let restoreError: unknown
  const client = new Client({ connectionString: withDatabase(databaseUrl, target) })
  try {
    await runner(
      'pg_restore',
      [
        '--exit-on-error',
        '--no-owner',
        `--dbname=${target}`,
        join(resolve(options.backupDir), backup.database.path),
      ],
      { ...env, PGDATABASE: 'postgres' },
    )
    await client.connect()
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query('SET LOCAL ROLE keel_control')
    verified = await readBackupSummary(client)
    await client.query('COMMIT')
    checks = compareSummaries(backup.summary, verified)
  } catch (error) {
    restoreError = error
  } finally {
    await client.end().catch(() => undefined)
  }

  const ok = restoreError === undefined && checks.every((check) => check.ok)
  if (!options.keepDatabase && ok) {
    await runner('dropdb', ['--if-exists', target], env).catch(() => undefined)
  }
  if (restoreError !== undefined) throw restoreError
  return {
    format: 'keel-restore-verify/v1',
    database_name: target,
    backup: resolve(options.backupDir),
    status: ok ? 'VERIFIED' : 'FAILED',
    checks,
    resume: await resumeDecision(verified ?? backup.summary, credentialAvailable),
  }
}

export async function listBackupFiles(directory: string): Promise<readonly string[]> {
  const base = resolve(directory)
  const output: string[] = []
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(join(current, entry.name), relative)
      else if (entry.isFile()) output.push(relative)
    }
  }
  await walk(base, '')
  return output.sort()
}
