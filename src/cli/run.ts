/**
 * keel CLI 的分发与生命周期(issue #27)。
 *
 * 从 `index.ts` 拆出来的原因:**测试要能 import 分发逻辑**,而入口文件
 * 一旦被 import 就该自动执行 `main()` —— 两者不能共处一个模块。
 *
 * 这里只做两件事:
 *   1. 把 argv 映射到子命令;
 *   2. **无论子命令成功、失败还是抛异常,退出前都关闭 `pg` 连接池**。
 *
 * 为什么关池是 CLI 的义务,而不是各子命令的:
 * `pg` 的 idle client 默认保持 socket,不 `pool.end()` 的话事件循环里始终有句柄,
 * 进程打印完结果也不会退出(实测 `keel status` 打印后 5 秒仍存活)。
 * 逐个命令手写 `finally { closePool() }` 一定会漏(本仓库就漏了除 poller 外的全部),
 * 所以收口在分发这一层。
 */

import { closePool } from '../fact/db.js'
import { backupMain, restoreVerifyMain } from './backup.js'
import { consoleMain } from './console.js'
import { answerMain, decideMain } from './decide.js'
import { doctorMain } from './doctor.js'
import { ingestIssueMain } from './ingest-issue.js'
import { managedMain } from './managed.js'
import { pollerMain } from './poller.js'
import { registerRepoMain } from './register-repo.js'
import { runIssueMain } from './run-issue.js'
import { runTaskMain } from './run-task.js'
import { serveMain, serviceHealthMain, serviceStatusMain } from './service.js'
import { statusMain } from './status.js'
import { taskControlMain } from './task-control.js'
import { timerWorkerMain } from './timer-worker.js'
import { trialMain } from './trial.js'
import { unlockMain } from './unlock.js'

export const VERSION = '0.1.0'

export const HELP = `keel — AI Engineering Runtime CLI

用法:
  keel <command> [args]

命令:
  serve [--harness omp|claude|pi] [--no-ingress]   统一常驻服务（JT-06）
  service-status [--stale-ms <ms>]             只读角色、队列与恢复状态
  service-health [--json]                      无副作用健康检查（非健康时退出 1）
  doctor [--harness omp|claude|pi] [--scope full|ticket] [--json]    Harness/平台/数据库/试运行就绪矩阵
  trial-start --projects <uuid,uuid> --confirm   开始 2–3 个项目的 7 天试运行
  trial-status [--json] [--require-eligible]     只读试运行门槛与样本状态
  trial-stop --reason <text> --confirm           停止当前试运行
  managed <investigate|status|questions|answer|worker|ticket-*|policy-*|workflow-*|action-*|memory-*>   调查、ticket、授权生命周期、路线图、受控 PR、required checks 与项目记忆（JT-01–05）
  backup --out <目录> [--blob-dir <目录>]      一致性备份数据库与 blob
  restore-verify --backup <目录> [--keep-database]   隔离恢复并校验备份
  console                          观测与人工控制面板(默认 http://127.0.0.1:4321)
  timer-worker [--interval <ms>]   到期收割 timer(默认单次;--interval 常驻)
  run-task <taskId> [--max-steps N] [--ci passed|failed|real] [--model <id>] [--harness omp|claude|pi] [--wall-clock <秒>]   驱动单 task 到终态
  status <taskId> [--events N]     查 task / run / 事件摘要
  decide <taskId> <approve|reject|rework> [--note <text>]   人工裁决 S-HUMAN_REVIEW 的任务
  answer <taskId> --text <text>    回答 S-NEED_CLARIFICATION 的澄清
  pause <taskId>                 暂停新轮次派发，当前轮次继续收尾
  resume <taskId> [--note <text>]  恢复自动派发；人工交回需交接说明
  takeover <taskId>              执行收尾后安全接管
  register-repo <remoteUrl> [--default-branch <name>] [--local-path <dir>] [--issue-label <name>]   注册 repo；可绑定本地项目目录、配置扫描 label
  ingest-issue <issueUrl> [--label <name>] [--repo <uuid>]   GitHub Issue → task
  run-issue <issueUrl> [--label <name>] [--max-steps N] [--ci passed|failed|real] [--model <id>] [--harness omp|claude|pi] [--wall-clock <秒>]   Issue → task → 驱动到终态
  poller [--interval <ms>] [--concurrency <n>] [--ci passed|failed|real] [--model <id>] [--harness omp|claude|pi] [--wall-clock <秒>]   常驻扫描各仓库 label 下的 open issue 并驱动
  unlock <repoId> [--force]        清理 SIGKILL 留下的 per-repo 锁（无 --force 只报告持有者）

选项:
  --help, -h   显示帮助
  --version    显示版本
`

function usage(): void {
  console.log(HELP)
}

/** argv → 子命令。不认识命令只置 exitCode,不抛。 */
export async function dispatch(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv

  switch (command) {
    case 'serve':
      await serveMain(rest)
      return
    case 'service-status':
      await serviceStatusMain(rest)
      return
    case 'service-health':
      await serviceHealthMain(rest)
      return
    case 'doctor':
      await doctorMain(rest)
      return
    case 'trial-start':
    case 'trial-status':
    case 'trial-stop':
      await trialMain([command, ...rest])
      return
    case 'backup':
      await backupMain(rest)
      return
    case 'restore-verify':
      await restoreVerifyMain(rest)
      return
    case 'managed':
      await managedMain(rest)
      return
    case 'console':
      await consoleMain(rest)
      return
    case 'timer-worker':
      await timerWorkerMain(rest)
      return
    case 'run-task':
      await runTaskMain(rest)
      return
    case 'status':
      await statusMain(rest)
      return
    case 'decide':
      await decideMain(rest)
      return
    case 'answer':
      await answerMain(rest)
      return
    case 'pause':
    case 'resume':
    case 'takeover':
      await taskControlMain(command, rest)
      return
    case 'register-repo':
      await registerRepoMain(rest)
      return
    case 'ingest-issue':
      await ingestIssueMain(rest)
      return
    case 'run-issue':
      await runIssueMain(rest)
      return
    case 'poller':
      await pollerMain(rest)
      return
    case 'unlock':
      unlockMain(rest)
      return
    case '--version':
    case '-v':
      console.log(`keel ${VERSION}`)
      return
    case '--help':
    case '-h':
    case undefined:
      usage()
      return
    default:
      console.error(`未知命令: ${command}`)
      usage()
      process.exitCode = 2
  }
}

export interface RunCliDeps {
  /** 退出前关闭连接池;测试注入假实现断言「真的关了」 */
  readonly closeDb?: () => Promise<void>
  /** 子命令分发;测试注入抛错实现,验证 finally 仍关池。缺省 `dispatch` */
  readonly dispatch?: (argv: readonly string[]) => Promise<void>
}

/**
 * 跑一个子命令并在结束后收掉连接池。
 *
 * 关池失败不改变退出结果:子命令已经跑完了,`pool.end()` 报错最多说明
 * 连接被对端提前关掉,不能因此把成功的命令变成失败。原始异常照常向上抛。
 */
export async function runCli(argv: readonly string[], deps: RunCliDeps = {}): Promise<void> {
  try {
    await (deps.dispatch ?? dispatch)(argv)
  } finally {
    await (deps.closeDb ?? closePool)().catch(() => undefined)
  }
}
