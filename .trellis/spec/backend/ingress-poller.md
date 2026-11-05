# 接入自动化 Poller（`keel poller`）

> 来源：`08-29-ingress-poller`（issue #70 §2）。代码：
> `src/cli/poller.ts`（接线）、`src/ingress/poller.ts`（轮询核心）、
> `src/fact/github-provider.ts`（`listOpenIssues`）。
> 目标：7×24 无人值守，把「人工反复跑 `keel run-issue`」变成常驻进程。

---

## Scenario: 常驻扫描多仓库 issue

### 1. Scope / Trigger

- 触发：生产环境需要自动发现并驱动 GitHub issue。
- 影响面：新增子命令、`repo.issue_label` 列、provider 列表能力、常驻进程的退出行为。
- 风险：label 读错会跨仓库误 ingest；常驻进程的监听泄漏 / 不退出只能靠运维重启发现。

### 2. Signatures

```bash
keel poller [--interval <ms>] [--ci passed|failed|real] [--model <id>]
            [--harness omp|claude] [--wall-clock <秒>]
# 没有 --label：label 的唯一事实源是 repo.issue_label
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
  now(); log(line: Record<string, unknown>)
}
export function createStopToken(): StopToken          // requested / listenerCount / subscribe / request
export function pollOnce(deps, opts?): Promise<PollRoundResult>
export function runPollerForever(deps, opts?): Promise<void>
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

**幂等**

- 事实来源是 `feedback(source='github', external_ref)` 唯一键 + `driver.intake`。
- 终态（`TERMINAL_STATUSES`）跳过；非终态继续驱动；无 task 才新建。
- 同一轮内按 `external_ref` 去重：`repo.remote_url` 没有唯一索引，两条 repo 行
  指向同一 remote 时不能在一轮里驱动两次。

**信号与退出**

- SIGTERM / SIGINT：每个 repo、每个 issue 之间检查 `shouldStop`；不再认领新 issue，
  当前 `runIssue` 结束后退出。**不杀**进行中的 run（强杀会留下 RUNNING run）。
- sleep 必须能被信号立刻打断（`StopToken` 订阅制），否则要挂满一个 interval。
- `pollerMain` 在 `finally` 里关闭连接池 —— 否则 `pg` 的 idle socket 让进程打印完不退出。

**日志**（单行 JSON）

```json
{"ts":"...","event":"poll","repos":2,"scanned":5,"ingested":1,"driven":1,"skipped":3,"errors":0,"truncated":false,"stopped":false}
{"ts":"...","event":"repo_error","repo":"o/r","label":"keel","kind":"...","detail":"..."}
{"ts":"...","event":"issue_error","ref":"o/r#12","kind":"...","detail":"..."}
{"ts":"...","event":"poller","state":"stopped"}
```

- `detail` 过 `redactSecrets`，并额外 `stripUserinfo`：remote 里自带的
  `https://user:token@host` 不是环境 token，`redactSecrets` 认不出来。
- 不打印 issue body。

### 4. Validation & Error Matrix

| 条件 | 结果 |
|---|---|
| `--interval` 非正整数 / 只写标志 | 拒绝，不静默回退 60000 |
| `--ci` 只写标志 | 拒绝，不静默回退 `real` |
| 传 `--label` | 拒绝，并指向 `repo.issue_label` |
| `--issue-label` 空白 | 写库前拒绝；零写入 |
| 缺少 GitHub token | 进入循环前失败（否则每轮每仓库一条 `AUTH_FAILED` 空转） |
| 单个 repo 列出失败 | `repo_error` 日志，`errors += 1`，继续下一个 repo |
| 单个 issue 驱动失败 | `issue_error` 日志，`errors += 1`，继续下一个 issue |
| 不可预期异常（DB 连接丢失等） | 照常抛出，不吞 |
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
- 同一轮同一 `external_ref` 只驱动一次
- `StopToken.listenerCount` 不随轮次增长（50 轮后为 0）；信号叫醒后清空
- SIGTERM 后下一轮不再扫描（`stopped: true`）

`src/cli/poller.test.ts`：

- `--interval` / `--ci` / `--label` 的拒绝路径
- 缺 token 前置失败
- 循环抛错时连接池仍被关闭

`src/fact/github-provider.test.ts`：

- PR 过滤、两页拼接、触顶 `truncated`、label 编码（空格 / 斜杠 / 中文）
- 空 label 不发请求

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
- **硬取消未实现**：正在跑的 `run` 没有外部取消接口；SIGTERM 只保证不再认领新工作。
  这是 PRD 里明确记录的 AC 偏离，硬取消留给后续任务。
- **与 timer-worker 分工**：poller 管扫描与驱动，timer 管到期收割；poller 不处理 wall-clock timer。
- **单进程**：不引入队列 / 并发框架；多实例调度 / 分池不在范围。
  同一数据库上的 poller 单实例由 CLI 启动期的 PostgreSQL advisory lock 强制
  （见 `cli-lifecycle.md` §常驻进程单实例），不会出现两个 poller 扫同一仓库。
- **连接池与信号**：poller 自己 `finally { closeDb() }` 只是兜底；CLI 统一在
  `runCli` 的 `finally` 关池（所有碰库子命令共用）。`timer-worker` 的 SIGTERM
  退出同样已收口 —— 两者规则见 `cli-lifecycle.md`。
