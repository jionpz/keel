# 接入自动化 Poller — 技术设计

## 1. 模块边界

```
src/cli/poller.ts        参数解析、日志、信号处理（接入层）
src/ingress/poller.ts    轮询逻辑（库函数，可注入依赖，可单测）
```

若 `src/ingress/` 不存在，则放 `src/cli/poller-core.ts` 并在 `directory-structure.md`
允许的边界内（CLI 层可依赖 control/fact/execution）。**不放进 control plane**：
poller 是接入层，不参与状态机决策。

## 2. GitHub 列表能力

`GitHubProvider` 新增：

```ts
export interface ListedIssue {
  readonly number: number
  readonly title: string
  readonly state: 'open' | 'closed'
  readonly isPullRequest: boolean
  readonly labels: readonly string[]
}

async listOpenIssues(
  remoteUrl: string,
  label: string,
): Promise<Result<readonly ListedIssue[]>>
```

请求：`/repos/<slug>/issues?state=open&labels=<label>&per_page=100`。

- 过滤 `pull_request !== undefined`（issues API 会把 PR 混进来）。
- 不在 provider 内做分页跟随：单页 100，`length === 100` 时由 poller 打一条
  `truncated: true` 日志。生产 issue 数量远小于 100；引入分页会牵动 `request`
  返回 headers，超出本任务范围。
- 复用 GHES 子任务的 `parseRemoteUrl` / `request(host, path)`。

## 3. 轮询算法

```
每轮：
  repos = SELECT id, remote_url, default_branch FROM repo WHERE provider='github'
  for repo in repos:
      issues = github.listOpenIssues(repo.remote_url, label)
      for issue in issues where !isPullRequest:
          ref = `${owner}/${repo}#${number}`
          task = findTaskByExternalRef(ref)
          if task 终态:            skipped++
          else:
              runIssue({ issueUrl })   // ingest 幂等 + 驱动
              ingested/driven++ 或 errors++
```

- `runIssue` 已包含「ingest + runTask」两段，poller 不复制任何一段逻辑。
- 非终态但已存在的 task：`ingestIssue` 会返回 `created=false`，`runTask` 继续驱动 ——
  正是需求 R3 要的行为。
- 终态判定复用 `TERMINAL_STATUSES`（`src/shared/ids.ts`），不新写集合。

## 4. 幂等与并发

- 数据库唯一键 `feedback(source, external_ref)` 是去重的事实来源；
  `driver.intake` 对同一 feedback 返回既有 task。
- 单进程顺序执行，不引入锁。多实例部署不在本任务范围；
  若未来需要，用 PostgreSQL advisory lock（记录在 `notes`，不提前实现）。
- 同一轮内不并发驱动多个 issue：Agent 驱动是重操作，顺序更容易诊断。

## 5. 信号与生命周期

```ts
export interface PollerDeps {
  readonly listRepos: () => Promise<RepoRow[]>
  readonly listIssues: (repo: RepoRow, label: string) => Promise<Result<ListedIssue[]>>
  readonly taskStatus: (externalRef: string) => Promise<string | undefined>
  readonly runIssue: (issueUrl: string) => Promise<Result<unknown>>
  readonly now: () => string
  readonly log: (line: Record<string, unknown>) => void
}
```

`runPollerForever(deps, { intervalMs })`：

1. 注册 `SIGTERM` / `SIGINT`，置 `stopRequested`。
2. 每轮开始检查 `stopRequested`；每个 issue 之间也检查。
3. 一轮结束后 `await sleep(intervalMs)`，sleep 用可被信号打断的实现
   （`Promise.race([sleep, stopPromise])`）。
4. 退出前打一行 `{"event":"poller","state":"stopped"}`。

**已知限制**（与 PRD 的 AC 调整一致）：正在执行的 `runIssue` 没有外部取消接口，
SIGTERM 只保证不再认领新 issue。当前 run 结束后进程退出。

## 6. 日志

单行 JSON，字段：

```json
{"ts":"...","event":"poll","repos":2,"scanned":5,"ingested":1,"driven":1,"skipped":3,"errors":0,"truncated":false}
{"ts":"...","event":"issue_error","ref":"o/r#12","kind":"WORKSPACE_ERROR","detail":"..."}
{"ts":"...","event":"poller","state":"stopped"}
```

- `detail` 在写入前过 §3 的 `redactSecrets`（token / base64）。
- 不打印 issue body（不可信输入，且可能很大）。

## 7. CLI

`src/cli/index.ts` 增加 `poller` 分支；帮助文本与 README 同步。

参数校验复用 `parseCiMode` / `resolveHarness` / `resolveModelForHarness` / `parseWallClock`，
空白与非法值拒绝 —— 与 `run-issue` 同一套，不写第二份。

## 8. 测试

- 纯逻辑（注入 deps，不碰数据库）：
  - 新 issue → 调 `runIssue`；
  - 已终态 task → 不调；
  - 非终态 task → 调；
  - 单个 issue 失败不影响后续；
  - SIGTERM 后下一轮不再扫描。
- provider `listOpenIssues`：stub server 返回含 PR 的列表，断言 PR 被过滤。
- e2e（可选）：本地 stub GitHub + 真库，跑一轮断言 task 创建。
