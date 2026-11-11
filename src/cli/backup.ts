/** JT-06 备份与隔离恢复校验 CLI。 */

import { createBackup, restoreVerify } from '../control/service/backup.js'
import { parseArgs } from './argv.js'

function option(flags: Record<string, unknown>, name: string): string | undefined {
  const value = flags[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`--${name} 需要非空值`)
  return value.trim()
}

export async function backupMain(argv: readonly string[]): Promise<void> {
  try {
    const { positionals, flags } = parseArgs(argv)
    if (flags.help === true) {
      console.log(`用法: keel backup --out <目录> [--blob-dir <目录>]

在当前 PostgreSQL 的 REPEATABLE READ 快照上生成自定义格式 dump，并复制被引用的
内容寻址 blob。输出目录必须不存在，避免覆盖旧演练。
数据库 URL 只从 KEEL_DATABASE_URL / DATABASE_URL 读取，不从 argv 传递。`)
      return
    }
    if (positionals.length > 0) throw new Error(`不接受位置参数：${positionals.join(' ')}`)
    if (Object.keys(flags).some((key) => !['out', 'blob-dir', 'help'].includes(key)))
      throw new Error('backup 只接受 --out 和 --blob-dir')
    const out = option(flags, 'out')
    if (out === undefined) throw new Error('缺少 --out')
    const manifest = await createBackup({
      outputDir: out,
      ...(option(flags, 'blob-dir') === undefined
        ? {}
        : { blobDir: option(flags, 'blob-dir') as string }),
    })
    console.log(JSON.stringify(manifest, null, 2))
  } catch (error) {
    console.error(`backup: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

export async function restoreVerifyMain(argv: readonly string[]): Promise<void> {
  try {
    const { positionals, flags } = parseArgs(argv)
    if (flags.help === true) {
      console.log(`用法: keel restore-verify --backup <目录> [--keep-database]

校验 manifest、DB dump 和 blob 摘要，在临时隔离库 pg_restore 后重新计算队列、
工作流包、待答问题和 blob 引用。默认删除临时库；--keep-database 保留证据。
缺 GitHub 凭据或存在 UNCERTAIN/EXECUTING 外部动作时，resume 明确为阻塞/回查。`)
      return
    }
    if (positionals.length > 0) throw new Error(`不接受位置参数：${positionals.join(' ')}`)
    if (Object.keys(flags).some((key) => !['backup', 'keep-database', 'help'].includes(key)))
      throw new Error('restore-verify 只接受 --backup 和 --keep-database')
    const backup = option(flags, 'backup')
    if (backup === undefined) throw new Error('缺少 --backup')
    const report = await restoreVerify({
      backupDir: backup,
      keepDatabase: flags['keep-database'] === true,
    })
    console.log(JSON.stringify(report, null, 2))
    if (report.status !== 'VERIFIED') process.exitCode = 1
  } catch (error) {
    console.error(`restore-verify: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
