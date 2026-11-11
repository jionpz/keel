import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashOf } from '../../fact/blob.js'
import { asOwner, closePool, connectionString } from '../../fact/db.js'
import { sha256CanonicalJson } from '../../shared/canonical-json.js'
import { createBackup, restoreVerify, verifyBackupDirectory } from './backup.js'

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
