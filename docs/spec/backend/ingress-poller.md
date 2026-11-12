# 接入自动化 Poller（`keel poller`）

> 来源：`08-29-ingress-poller`（issue #70 §2）、issue 关闭对账（issue #82）。代码：
> `src/cli/poller.ts`（接线）、`src/ingress/poller.ts`（轮询核心）、
> `src/ingress/reconcile.ts`（issue 关闭对账）、
> `src/fact/github-provider.ts`（`listOpenIssues` / `getIssue`）。
> 目标：7×24 无人值守，把「人工反复跑 `keel run-issue`」变成常驻进程。

---

## Scenario: 常驻扫描多仓库 issue

### 1. Scope / Trigger

- 触发：生产环境需要自动发现并驱动 GitHub issue。
- 影响面：新增子命令、`repo.issue_label` 列、provider 列表能力、常驻进程的退出行为。
- 风险：label 读错会跨仓库误 ingest；常驻进程的监听泄漏 / 不退出只能靠运维重启发现。

### 2. Signatures

```bash
keel poller [--interval <ms>] [--concurrency <n>] [--ci passed|failed|real]
            [--model <id>] [--harness omp|claude] [--wall-clock <秒>]
# 没有 --label：label 的唯一事实源是 repo.issue_label
# --concurrency 缺省 = 全局 DEFAULT_MAX_RUNNING_RUNS(3)，超过上限启动期拒绝
```

```ts
// migrations/1000000000006_repo_issue_label.sql
ALTER TABLE repo ADD COLUMN issue_label text NOT NULL DEFAULT 'keel';
ALTER TABLE repo ADD CONSTRAINT repo_issue_label_nonempty CHECK (btrim(issue_label) <> '');

// src/cli/register-repo.ts
keel register-repo <remoteUrl> --issue-label <name>

// src/fact/github-provider.ts
export interface ListedIssue { number; title; state; isPullRequest; labels }
export interface IssueList { issues: readonly ListedIssue[]; truncated: boolean }
listOpenIssues(remoteUrl: string, label: string, opts?: { maxPages?: number }): Promise<Result<IssueList>>
export function issueUrlFor(parsed: ParsedRemote, number: number): string

// src/ingress/poller.ts
export interface PollerDeps {
  listRepos(); listIssues(repo); taskStatus(externalRef)
  runIssue(input: { issueUrl; repoId; label: string })
  reconcile: ReconcileDeps                          // issue 关闭对账（见下）
  now(); log(line: Record<string, unknown>)
}
export function createStopToken(): StopToken          // requested / listenerCount / subscribe / request
export function scanOnce(deps, opts?): Promise<{ stats: ScanStats; drives: DriveRequest[]; openRefs: ReadonlySet<string>; stopped }>
export function createDriveScheduler(deps, opts: {
  concurrency: number; shouldStop?; onFatal?
}): DriveScheduler                                   // schedule / inFlight / drain / takeFatal
export type ScheduleOutcome = 'scheduled' | 'in_flight' | 'at_capacity' | 'stopped'
export interface DriveFatal { readonly value: unknown }
// takeFatal(): DriveFatal | undefined
// 包装对象而非直接返回 unknown：`throw undefined` 也是合法抛出值，
// 否则「没有 fatal」与「fatal 是 undefined」无法区分，异常会被静默吞掉。
export const DEFAULT_DRIVE_CONCURRENCY = 3           // 与 N4 全局上限一致
export function pollOnce(deps, opts?): Promise<PollRoundResult>   // 一次性同步语义（测试 / 脚本）
export function runPollerForever(deps, opts?): Promise<void>      // opts.concurrency

// src/ingress/reconcile.ts
export interface IngestedTask { taskId; status; externalRef; remoteUrl }
export interface IssueState { state: 'open' | 'closed'; closedAt: string | null }
export interface ReconcileDeps {
  listIngestedTasks(); issueState(remoteUrl, issueNumber)
  cancelTask(task, issue, now); redactDetail(detail); now(); log(line)
}
export function cancellationApplies(status: TaskStatus): boolean   // T-040 的显式守卫
export function reconcileClosedIssues(deps, openRefs, opts?): Promise<ReconcileStats>
export function parseIssueNumber(externalRef): number | undefined

// src/cli/poller.ts
export function parseConcurrency(raw: unknown): Result<number>    // 缺省 DEFAULT_MAX_RUNNING_RUNS
export function loadIngestedGithubTasks(): Promise<readonly IngestedTask[]>
export function cancelClosedIssue(task, issue, now): Promise<Result<CancelOutcome>>
```

### 3. Contracts

**扫描范围与 label**

- 每轮 `SELECT id, remote_url, default_branch, issue_label FROM repo WHERE provider='github'`。
- 每个仓库用**自己的** `issue_label` 拉 issue；`--label` 不存在，传了要明确拒绝。
- `ingestIssue` 的 label 闸门用它，所以 `runIssue` 必须收到该仓库的 label。

**`listOpenIssues`**

- `GET /repos/<slug>/issues?state=open&labels=<label>&per_page=100&page=<n>`，
  一并过滤 `pull_request !== undefined`。
- 不足 100 条即停；最多 `maxPages`（默认 10）页；触顶且末页仍满 → `truncated: true`。
- 跨页按 `number` 去重；label 用 `URLSearchParams` 编码，不手拼 query。
- **空 label 直接拒绝**：GitHub 在 `labels=` 为空时会列出全部 open issue，等于跨过闸门。

**扫描与驱动解耦（常驻路径）**

- `runPollerForever` 每轮只 `scanOnce` + 调度，**不 await 驱动完成**；下一轮按
  `--interval` 照常开始。一个顶满墙钟的 `develop` 不再让同轮其余 issue 与后续轮次等待。
- 并发上限 `--concurrency`（缺省 `DEFAULT_DRIVE_CONCURRENCY = 3`，等于 N4
  `DEFAULT_MAX_RUNNING_RUNS`）。`inFlight.size >= concurrency` 时返回
  `at_capacity`，本轮记为 `deferred`，**不排队**：下一轮重新扫描时再试。
- `createDriveScheduler` 只做进程内节流，不读数据库；真正的并发事实仍是
  claim 的 N3 乐观锁 + N4 上限 + `run_one_running_per_task` 唯一索引。
- `pollOnce` 保留「扫描 + 顺序驱动」的一次性语义（测试 / 脚本 / 诊断），
  聚合行字段不变；常驻路径不再使用它。

**幂等**

- 事实来源是 `feedback(source='github', external_ref)` 唯一键 + `driver.intake`。
- 终态（`TERMINAL_STATUSES`）跳过；非终态继续驱动；无 task 才新建。
- 同一轮内按 `external_ref` 去重：`repo.remote_url` 没有唯一索引，两条 repo 行
  指向同一 remote 时不能在一轮里驱动两次。
- 跨轮：调度器的 `inFlight` 集合以 `external_ref` 为键；驱动未结束时再次调度返回
  `in_flight`，计入 `skipped`，不会并发双跑。驱动结束（成功 / 可预期失败）后
  才从集合摘除，下一轮可再次驱动。

**issue 关闭对账（issue #82）**

- 每轮扫描之后、调度驱动之前跑一次 `reconcileClosedIssues`。
- 候选集 = 已 ingest、非终态的 GitHub 任务（`loadIngestedGithubTasks`：
  `task ⋈ task_feedback ⋈ feedback(source='github') ⋈ repo(provider='github')`）。
- **本轮 open 列表里见过的任务零请求跳过**（`scanOnce` 返回 `openRefs`）；
  没见过的才逐条 `getIssue` 回查，用来区分「已关闭」与「只是被摘了 label」。
- 读到 `state=closed` → 发 `Cancelled`（T-040）：`reason: 'issue_closed'`、
  `closed_at` 来自 GitHub 响应，写进 `TaskStatusChanged` 的 payload；
  工作区由 T-040 的 `CleanWorkspace` 收掉（有工作树时注入真实 workspace，
  准备失败不阻断取消，如实记 `SideEffectIntent`）。
- **关闭 ≠ 取消的显式守卫**：`cancellationApplies(status)` 只对 `S-PR_OPEN` 返回 false。
  PR 已经开出去时，交付物落在 PR 上继续收口，issue 关闭不撤单；这类任务计入
  `reconcile.skipped` 并打 `reconcile_skipped`。其余非终态没有脱离 issue 仍成立的
  交付物，关闭就是撤单。误取消不可逆（终态 I8），宁可漏取消也不能错取消。
- 按设计**不为 closed issue 重新 ingest 新任务**：`ingestIssue` 的关闭闸门是授权边界，
  对账不绕过它。`S-PR_OPEN` 是唯一例外：任务已经 ingest 过，poller 从独立任务列表
  继续观察 PR，不重走 issue 闸门。
- 单条失败隔离：issue 状态查询或取消失败只记 `reconcile_error` + `errors += 1`，
  不影响其它任务；取消因并发未推进记 `reconcile_noop`，不假装成功。

**S-PR_OPEN 独立观察（issue #132）**

- `scanOnce` 在 open issue 扫描之外追加 `listPrOpenTasks()`：列出所有仍处于
  `S-PR_OPEN` 的 GitHub Task。PR 合并后 `Closes #n` 会让 issue 自动关闭，
  因此不能只依赖 open issue 列表。
- 同一轮已从 open 列表认领的 `external_ref` 不重复驱动；`prOpen` 只统计
  本轮纳入观察的 S-PR_OPEN 任务数。
- 驱动入口按当前 Task 状态分流：`S-PR_OPEN` 直接续驱，不重新 ingest；
  CI 已记录时直接观察 PR，PR 仍 open 则停在 `awaiting-pr-merge`。
- **未合并关闭后的重驱动**：open issue 的最新 Task 为 `S-ABANDONED`，且最近
  `PRClosed` 的理由是 `pr_closed_unmerged` 时，`redriveCandidate` 返回候选；
  poller 以 `redrive: true` 调 `runIssue`，复用原 GitHub Feedback 并追加
  `redrive:<previousTaskId>` 说明 Feedback。其它终态或其它放弃理由一律跳过。
- 重驱动后新 Task 会成为同一 issue 的最新 Task，后续轮次不会拿旧的
  `S-ABANDONED` 反复重开。

**信号与退出**

- SIGTERM / SIGINT：不再调度新 issue；**所有在途驱动**（`scheduler.drain()`）结束后退出。
  **不杀**进行中的 run（强杀会留下 RUNNING run）。
- `drain()` 在 `finally`：扫描 / 日志抛错也不留下未收尾的驱动 promise。
- 驱动抛异常（编程错误 / 基础设施故障）：记首个 fatal → `onFatal()` 请求停止 →
  在途收尾后把该异常抛出进程；**不打** `poller stopped` 行。
  抛出值原样传播：`throw undefined` / `Promise.reject()` 也照抛，不当成「没有 fatal」。
- sleep 必须能被信号立刻打断（`StopToken` 订阅制），否则要挂满一个 interval。
- `pollerMain` 在 `finally` 里关闭连接池 —— 否则 `pg` 的 idle socket 让进程打印完不退出。

**日志**（单行 JSON）

```json
{"ts":"...","event":"poll","repos":2,"scanned":5,"skipped":3,"prOpen":1,"errors":0,"truncated":false,"scheduled":2,"deferred":1,"inFlight":3,"reconcile":{"checked":1,"cancelled":1,"skipped":0,"errors":0},"stopped":false}
{"ts":"...","event":"issue_driven","ref":"o/r#12","created":true}
{"ts":"...","event":"reconcile_cancelled","ref":"o/r#12","task":"<uuid>","from":"S-HUMAN_REVIEW","transition":"T-040","closed_at":"2026-11-07T12:34:56Z"}
{"ts":"...","event":"reconcile_skipped","ref":"o/r#12","task":"<uuid>","status":"S-PR_OPEN","reason":"pr_open"}
{"ts":"...","event":"reconcile_error","ref":"o/r#12","kind":"...","detail":"..."}
{"ts":"...","event":"reconcile_noop","ref":"o/r#12","task":"<uuid>","reason":"..."}
{"ts":"...","event":"repo_error","repo":"o/r","label":"keel","kind":"...","detail":"..."}
{"ts":"...","event":"issue_error","ref":"o/r#12","kind":"...","detail":"..."}
{"ts":"...","event":"poller","state":"stopped"}
```

- 常驻 `poll` 行：`scheduled` 是本轮**启动**的驱动数，不承诺完成数；
  `deferred` 是本轮因并发上限未启动的请求数；`inFlight` 是打印时的在途数；
  `reconcile` 是本轮 issue 关闭对账的四项计数。
- `pollOnce` 的聚合行仍为 `repos / scanned / ingested / driven / skipped / errors /
  truncated / stopped`（兼容保留）。

- `detail` 过 `redactSecrets`，并额外 `stripUserinfo`：remote 里自带的
  `https://user:token@host` 不是环境 token，`redactSecrets` 认不出来。
- 不打印 issue body。

### 4. Validation & Error Matrix

| 条件 | 结果 |
|---|---|
| `--interval` 非正整数 / 只写标志 | 拒绝，不静默回退 60000 |
| `--concurrency` 0 / 负数 / 小数 / 非数字 / 只写标志 | 拒绝，不静默回退全局上限；启动期退出码 1 |
| `--concurrency` 超过 `DEFAULT_MAX_RUNNING_RUNS` | 拒绝，文案点名全局上限与调整方式 |
| `--ci` 只写标志 | 拒绝，不静默回退 `real` |
| 传 `--label` | 拒绝，并指向 `repo.issue_label` |
| `--issue-label` 空白 | 写库前拒绝；零写入 |
| 缺少 GitHub token | 进入循环前失败（否则每轮每仓库一条 `AUTH_FAILED` 空转） |
| 单个 repo 列出失败 | `repo_error` 日志，`errors += 1`，继续下一个 repo |
| 单个 issue 驱动返回 `err` | `issue_error` 日志，不影响其它在途驱动与后续轮次 |
| 驱动数已达并发上限 | `deferred += 1`，不排队；下一轮重扫 |
| 同一 `external_ref` 已在途 | `in_flight`，计入 `skipped`，不重复驱动 |
| 驱动抛异常（DB 连接丢失等） | 记首个 fatal → 停止调度 → 在途收尾后抛出，不吞 |
| issue 状态查询失败 | `reconcile_error`，`errors += 1`，继续下一条 |
| issue 已关闭且任务 `S-PR_OPEN` | 不取消（显式守卫），`reconcile.skipped += 1`，打 `reconcile_skipped` |
| `S-PR_OPEN` 任务即使 issue 已关闭 | 仍由独立任务列表驱动，直到 PR merged / closed |
| 最新 Task `S-ABANDONED` 且理由 `pr_closed_unmerged` | 带重驱动候选调 `runIssue`；其余放弃理由跳过 |
| issue 不在 open 列表但状态仍 open（label 被摘） | 不做任何动作 |
| 取消因并发未推进 | `reconcile_noop`，不计入 `cancelled` |
| `external_ref` 形状不对 | `reconcile_error`，不发请求、不取消 |
| `listOpenIssues` 非数组 / 元素形状不对 | `PROTOCOL_ERROR`（不静默跳过） |

### 5. Good / Base / Bad Cases

- **Good**：repo A 用 `keel`、repo B 用 `bug`，同一轮各自按自己的 label 扫描；
  日志里 `label` 字段能区分。
- **Base**：没有 task 的 issue → `runIssue` → 新建并驱动；下一轮看到非终态 → 继续驱动。
- **Bad**：给 poller 加一个全局 `--label`，覆盖各仓库配置 —— 多项目场景无法表达，
  且会与 `repo.issue_label` 漂移。

### 6. Tests Required

`src/ingress/poller.test.ts`（注入 deps，不碰数据库）：

- 每个仓库用自己的 label 调 `runIssue`；label 透传
- 新 issue 驱动 / 终态跳过 / 非终态继续
- 单条失败隔离；错误日志脱敏
- issue 已关闭但 Task `S-PR_OPEN` 仍被纳入观察；同一轮不重复驱动
- `S-ABANDONED + pr_closed_unmerged` 进入重驱动；其它终态/理由跳过
- 同一轮同一 `external_ref` 只驱动一次
- `scanOnce` 只返回待驱动请求，不调用 `runIssue`
- 调度器：`N+1` 个请求时最多 `N` 个在途、其余 `at_capacity`；同一 ref 在途时
  `in_flight` 不双跑；`drain()` 等在途收尾；首个 fatal 记录 + `onFatal` 只调一次，
  `drain()` 仍能 resolve
- 常驻循环：一个永不返回的驱动不阻塞后续轮扫描与调度；同一 ref 跨轮不双跑；
  SIGTERM 后不再调度新 issue、在途驱动结束后才退出；失败隔离；fatal 在收尾后抛出
  （含 `throw undefined`：仍以抛出结束，不打 `poller stopped`）
- `StopToken.listenerCount` 不随轮次增长（50 轮后为 0）；信号叫醒后清空

`src/cli/poller.test.ts`：

- `--interval` / `--ci` / `--label` / `--concurrency` 的拒绝路径
  （`--concurrency` 覆盖 0 / 负数 / 小数 / 非数字 / 只写标志 / 超上限）
- `--concurrency` 缺省 = 全局上限；显式值透传到常驻循环（在途数随之变化）
- `DEFAULT_DRIVE_CONCURRENCY` 与全局 `DEFAULT_MAX_RUNNING_RUNS` 不漂移（数值断言）
- 缺 token 前置失败；非法 `--concurrency` 不读 repo、不取锁、不解析 token
- 循环抛错时连接池仍被关闭
- `listPrOpenTasks` / `redriveCandidate` 接到 `runIssue`，重驱动候选映射为
  `redrive: true`

`src/ingress/reconcile.test.ts`（注入 deps，不碰数据库与 GitHub）：

- closed → `cancelTask` 带 `closed_at`；`closed_at` 缺失保持 `null`
- 本轮 `openRefs` 里见过 → 零请求；issue 仍 open（label 被摘）→ 不撤单
- `S-PR_OPEN` 显式放行：不查 issue、不取消、计入 `skipped`
- 状态查询失败 / 取消失败 / `external_ref` 形状不对 → 错误隔离
- 取消未推进 → `reconcile_noop`，不计入 `cancelled`
- 停止信号 → 不再发起新对账
- `cancellationApplies` 只对 `S-PR_OPEN` 为 false

`src/fact/github-provider.test.ts`：

- PR 过滤、两页拼接、触顶 `truncated`、label 编码（空格 / 斜杠 / 中文）
- 空 label 不发请求
- `getIssue` 原样带出 `closed_at`（缺失为 `null`）

### 7. Wrong vs Correct

**Wrong**：把「停止」做成一个永不 resolve 的 promise，每轮 `sleep` 都挂 `.then`

```ts
const stopped = new Promise<void>((r) => (wake = r))
await Promise.race([sleep(ms), stopped])   // 每轮多一个永久 reaction
```

**Correct**：订阅制，等待者在结束（超时 / 被叫醒）时自己反注册

```ts
const token = createStopToken()
await sleepInterruptibly(ms, token)   // 结束后 unsubscribe
token.request()                        // 只置位一次并清空订阅者
```

---

## 运行前提与已知边界

- **GitHub token 必填**：poller 用 provider 列 issue，无 token 直接失败。
- **硬取消未实现**：正在跑的 `run` 没有外部取消接口；SIGTERM 只保证不再调度新 issue，
  并等所有在途驱动自然收尾。这是 PRD 里明确记录的 AC 偏离，硬取消留给后续任务。
  因此一个永不返回的驱动会让进程停在 drain —— 这是刻意的，不是挂死。
- **deferred 不是队列**：本轮排不下的 issue 只计数、不保存；下一轮重新扫描时再试。
  调度器里唯一的状态是 `inFlight` 集合，进程重启即清空，不构成第二份待办事实。
- **closed issue 只允许已 ingest 的 `S-PR_OPEN` 继续收口**：独立任务列表观察 PR
  合并/关闭；其它状态会被对账取消，且不会重新 ingest。重驱动只服务于
  `pr_closed_unmerged`，并要求 issue 仍 open 且带注册 label。
- **扫描先于驱动**：一轮会先扫描完所有仓库再调度，所以停止信号只影响「是否继续调度」，
  不会回滚已经完成的扫描（`pollOnce` 的 `scanned` 因此可能多于旧版）。
- **与 timer-worker 分工**：poller 管扫描与驱动，timer 管到期收割；poller 不处理 wall-clock timer。
- **单进程**：不引入队列 / 并发框架；多实例调度 / 分池不在范围。
  同一数据库上的 poller 单实例由 CLI 启动期的 PostgreSQL advisory lock 强制
  （见 `cli-lifecycle.md` §常驻进程单实例），不会出现两个 poller 扫同一仓库。
  并发上限只在本进程内计数；多实例时的硬约束仍是 N4。
- **连接池与信号**：poller 自己 `finally { closeDb() }` 只是兜底；CLI 统一在
  `runCli` 的 `finally` 关池（所有碰库子命令共用）。`timer-worker` 的 SIGTERM
  退出同样已收口 —— 两者规则见 `cli-lifecycle.md`。
