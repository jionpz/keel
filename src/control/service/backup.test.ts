import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashOf } from '../../fact/blob.js'
import { asOwner, closePool, connectionString } from '../../fact/db.js'
import { sha256CanonicalJson } from '../../shared/canonical-json.js'
import { fixtureRoutePackage } from '../managed/route-test-utils.js'
import { fixtureTicketPackage } from '../managed/ticket-test-utils.js'
import { createBackup, pgEnvironment, restoreVerify, verifyBackupDirectory } from './backup.js'

const HASH = 'a'.repeat(64)
const tempDirs: string[] = []

async function tempDir(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `keel-${label}-`))
  tempDirs.push(directory)
  return directory
}

async function clean(): Promise<void> {
  await asOwner((c) => c.query('TRUNCATE repo, managed_package RESTART IDENTITY CASCADE'))
}

interface Fixture {
  readonly repoId: string
  readonly taskId: string
  readonly blobDir: string
  readonly blobHash: string
}

async function seed(options: { readonly outbox?: 'PENDING' | 'UNCERTAIN' } = {}): Promise<Fixture> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  const legacyTaskId = randomUUID()
  const questionId = randomUUID()
  const ticketId = randomUUID()
  const intentId = randomUUID()
  const outboxId = randomUUID()
  const blobDir = await tempDir('blob')
  const blobHash = hashOf(Buffer.from('backup blob payload'))
  const blobParent = join(blobDir, blobHash.slice(0, 2))
  await mkdir(blobParent, { recursive: true })
  await writeFile(join(blobParent, blobHash.slice(2)), 'backup blob payload')

  const packageDigest = sha256CanonicalJson({})
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo(id,provider,remote_url,default_branch)
       VALUES($1,'local',$2,'main')`,
      [repoId, `file:///tmp/backup-${repoId}`],
    )
    await c.query('INSERT INTO managed_package(digest,body) VALUES($1,$2::jsonb)', [
      packageDigest,
      '{}',
    ])
    await c.query(
      `INSERT INTO managed_task(
        id,repo_id,package_digest,workspace_path,question,file_index,status,phase
      ) VALUES($1,$2,$3,'/tmp/backup','backup?','[]'::jsonb,'WAITING_HUMAN','investigate')`,
      [taskId, repoId, packageDigest],
    )
    await c.query(
      `INSERT INTO task(id,status,title,repo_id,base_branch,work_branch)
       VALUES($1,'S-NEW','backup fixture',$2,'main','ai/backup-fixture')`,
      [legacyTaskId, repoId],
    )
    await c.query(
      `INSERT INTO managed_question(id,task_id,question,options,status)
       VALUES($1,$2,'backup?','["yes","no"]'::jsonb,'WAITING_HUMAN')`,
      [questionId, taskId],
    )
    await c.query(`UPDATE managed_task SET pending_question_id=$2 WHERE id=$1`, [
      taskId,
      questionId,
    ])

    // artifact 需要一个 event 的全局逻辑序；body 指向内容寻址 blob。
    const event = await c.query<{ seq: string }>(
      `INSERT INTO event(task_id,type,payload)
       VALUES($1,'BackupFixture','{}'::jsonb) RETURNING seq`,
      [legacyTaskId],
    )
    await c.query(
      `INSERT INTO artifact(
        id,task_id,kind,key,version,schema_version,body,committed_at_seq
      ) VALUES($1,$2,'checkpoint','backup',1,'1.0',
               $3::jsonb,$4)`,
      [
        randomUUID(),
        legacyTaskId,
        JSON.stringify({ $ref: `blob://${blobHash}`, size: 20, preview: 'backup' }),
        event.rows[0]?.seq,
      ],
    )

    if (options.outbox !== undefined) {
      await c.query(
        `INSERT INTO managed_ticket_task(
          id,repo_id,package_digest,ticket_id,ticket_title,baseline_commit,
          worktree_path,current_stage,status
        ) VALUES($1,$2,$3,'backup-ticket','backup ticket',$4,'/tmp/backup-worktree',
                 'land','WAITING_GATEWAY')`,
        [ticketId, repoId, packageDigest, 'b'.repeat(40)],
      )
      await c.query(
        `INSERT INTO managed_action_intent(
          id,task_id,project_id,repo_id,action,remote_url,base_branch,head_branch,
          head_sha,diff_digest,environment,reversibility,affected_resources,
          pr_title,pr_body,idempotency_key
        ) VALUES($1,$2,$3,$3,'push_and_pr','file:///tmp/backup.git','main','ai/backup',
                 $4,$5,'local','reversible','["backup"]'::jsonb,'backup','backup',$6)`,
        [intentId, ticketId, repoId, 'c'.repeat(40), HASH, `backup-${intentId}`],
      )
      await c.query(
        `INSERT INTO managed_action_outbox(id,action_intent_id,status)
         VALUES($1,$2,$3)`,
        [outboxId, intentId, options.outbox],
      )
    }
  })

  return { repoId, taskId, blobDir, blobHash }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })))
})

beforeEach(clean)
afterAll(closePool)

describe('JT-06 backup / restore-verify', () => {
  it('pgEnvironment 使用 URL 查询参数中的有效连接地址', () => {
    const env = pgEnvironment(
      'postgres://url-user:url-pass@tcp.example:5432/db%20name' +
        '?host=%2Ftmp%2Fpostgresql&port=6543' +
        '&user=query%40user&password=query%3Apass&sslmode=verify-full',
      { PATH: '/bin', PGHOST: 'stale', PGSERVICE: 'stale' },
    )

    expect(env).toMatchObject({
      PATH: '/bin',
      PGHOST: '/tmp/postgresql',
      PGPORT: '6543',
      PGUSER: 'query@user',
      PGPASSWORD: 'query:pass',
      PGDATABASE: 'db name',
      PGSSLMODE: 'verify-full',
    })
    expect(env).not.toHaveProperty('PGSERVICE')
  })

  it('pgEnvironment 对缺失值、空查询参数和非法 URL 编码给出确定行为', () => {
    const authority = pgEnvironment('postgres://tcp.example:5433/database?host=&port=', {})
    expect(authority.PGHOST).toBe('tcp.example')
    expect(authority.PGPORT).toBe('5433')

    const env = pgEnvironment('postgres:///database', { PATH: '/bin' })

    expect(env).not.toHaveProperty('PGHOST')
    expect(env).not.toHaveProperty('PGPORT')
    expect(env).not.toHaveProperty('PGUSER')
    expect(env).not.toHaveProperty('PGPASSWORD')
    expect(env.PGDATABASE).toBe('database')
    expect(() => pgEnvironment('postgres://user%ZZ@tcp.example/database')).toThrow(
      /username百分号编码非法/,
    )
    expect(() => pgEnvironment('postgres:///database%ZZ')).toThrow(/数据库名百分号编码非法/)
  })

  it('真实 ticket/route 包的内容摘要与整包摘要分别校验并完整恢复', async () => {
    const fixture = await seed()
    const packages = [fixtureTicketPackage(), fixtureRoutePackage()]
    for (const body of packages) {
      expect(sha256CanonicalJson(body)).not.toBe(body.content_digest)
      await asOwner((client) =>
        client.query('INSERT INTO managed_package(digest,body) VALUES($1,$2::jsonb)', [
          body.content_digest,
          JSON.stringify(body),
        ]),
      )
    }
    const backupDir = join(await tempDir('protocol-packages'), 'package')
    const manifest = await createBackup({
      outputDir: backupDir,
      blobDir: fixture.blobDir,
      databaseUrl: connectionString(),
    })
    for (const body of packages) {
      expect(manifest.summary.packages).toContainEqual({
        digest: body.content_digest,
        body_sha256: sha256CanonicalJson(body),
      })
    }
    const report = await restoreVerify({ backupDir, databaseUrl: connectionString() })
    expect(report.status).toBe('VERIFIED')
    expect(report.checks.every((check) => check.ok)).toBe(true)
  })

  it('拒绝真实 ticket/route 包正文或内嵌摘要篡改，不退回整包摘要放行', async () => {
    const fixture = await seed()
    for (const body of [fixtureTicketPackage(), fixtureRoutePackage()]) {
      await asOwner((client) =>
        client.query('INSERT INTO managed_package(digest,body) VALUES($1,$2::jsonb)', [
          body.content_digest,
          JSON.stringify({ ...body, content_digest: '0'.repeat(64) }),
        ]),
      )
      await expect(
        createBackup({
          outputDir: join(await tempDir('tampered-protocol'), 'package'),
          blobDir: fixture.blobDir,
          databaseUrl: connectionString(),
        }),
      ).rejects.toThrow(/内容摘要不一致/)
      await asOwner((client) =>
        client.query('UPDATE managed_package SET body=$2::jsonb WHERE digest=$1', [
          body.content_digest,
          JSON.stringify({ ...body, source_commit: 'b'.repeat(40) }),
        ]),
      )
      await expect(
        createBackup({
          outputDir: join(await tempDir('tampered-protocol-body'), 'package'),
          blobDir: fixture.blobDir,
          databaseUrl: connectionString(),
        }),
      ).rejects.toThrow(/内容摘要不一致/)
      await asOwner((client) =>
        client.query('DELETE FROM managed_package WHERE digest=$1', [body.content_digest]),
      )
    }
  })

  it('真实备份后能在隔离库恢复，校验摘要并恢复同一待答问题', async () => {
    const fixture = await seed()
    const backupDir = join(await tempDir('backup'), 'package')
    const manifest = await createBackup({
      outputDir: backupDir,
      blobDir: fixture.blobDir,
      databaseUrl: connectionString(),
    })

    expect(manifest.format).toBe('keel-backup/v1')
    expect(manifest.summary.blob_refs).toContain(fixture.blobHash)
    expect(manifest.summary.pending.questions).toBe(1)
    await expect(verifyBackupDirectory(backupDir)).resolves.toMatchObject({
      format: 'keel-backup/v1',
    })

    const report = await restoreVerify({
      backupDir,
      databaseUrl: connectionString(),
      keepDatabase: false,
      credentialAvailable: async () => false,
    })
    expect(report.status).toBe('VERIFIED')
    expect(report.database_name).toMatch(/^keel_restore_/)
    expect(report.checks.every((check) => check.ok)).toBe(true)
    expect(report.resume.status).toBe('WAITING_HUMAN')
    expect(report.resume.reason).toContain('待答问题')
  })

  it('篡改 manifest 的签名、DB dump 或 blob 时 fail closed', async () => {
    const fixture = await seed()
    const backupDir = join(await tempDir('tamper'), 'package')
    await createBackup({
      outputDir: backupDir,
      blobDir: fixture.blobDir,
      databaseUrl: connectionString(),
    })

    const manifestPath = join(backupDir, 'manifest.json')
    const originalManifest = await readFile(manifestPath)
    await writeFile(manifestPath, `${originalManifest.toString('utf8')}\n`)
    await expect(verifyBackupDirectory(backupDir)).rejects.toThrow(/manifest\.sha256/)
    await writeFile(manifestPath, originalManifest)

    const blob = await readFile(
      join(backupDir, 'blobs', fixture.blobHash.slice(0, 2), fixture.blobHash.slice(2)),
    )
    await writeFile(
      join(backupDir, 'blobs', fixture.blobHash.slice(0, 2), fixture.blobHash.slice(2)),
      'tampered',
    )
    await expect(verifyBackupDirectory(backupDir)).rejects.toThrow(/blob/)
    await writeFile(
      join(backupDir, 'blobs', fixture.blobHash.slice(0, 2), fixture.blobHash.slice(2)),
      blob,
    )

    const dumpPath = join(backupDir, 'database.dump')
    const dump = await readFile(dumpPath)
    await writeFile(dumpPath, Buffer.concat([dump, Buffer.from('tampered')]))
    await expect(verifyBackupDirectory(backupDir)).rejects.toThrow(/数据库备份摘要/)
  })

  it('缺 GitHub 凭据且存在外部动作时明确返回 BLOCKED_CREDENTIALS', async () => {
    const fixture = await seed({ outbox: 'PENDING' })
    const backupDir = join(await tempDir('credentials'), 'package')
    await createBackup({
      outputDir: backupDir,
      blobDir: fixture.blobDir,
      databaseUrl: connectionString(),
    })

    const report = await restoreVerify({
      backupDir,
      databaseUrl: connectionString(),
      keepDatabase: false,
      credentialAvailable: async () => false,
    })
    expect(report.status).toBe('VERIFIED')
    expect(report.resume.status).toBe('BLOCKED_CREDENTIALS')
    expect(report.resume.github_credential).toBe(false)
  })

  it('EXECUTING/UNCERTAIN 外部动作恢复后先回查，不自动重放', async () => {
    const fixture = await seed({ outbox: 'UNCERTAIN' })
    const backupDir = join(await tempDir('reconcile'), 'package')
    await createBackup({
      outputDir: backupDir,
      blobDir: fixture.blobDir,
      databaseUrl: connectionString(),
    })

    const report = await restoreVerify({
      backupDir,
      databaseUrl: connectionString(),
      keepDatabase: false,
      credentialAvailable: async () => false,
    })
    expect(report.status).toBe('VERIFIED')
    expect(report.resume.status).toBe('BLOCKED_UNTIL_RECONCILE')
    expect(report.resume.reason).toContain('回查')
  })
})
