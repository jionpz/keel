# 接入自动化 Poller — 技术设计

> 2026-11-03 修订：仓库级 label（§2）、分页（§3）、显式依赖顺序（§9）。

## 1. 模块边界

```
src/cli/poller.ts        参数解析、日志、信号处理（接入层）
src/ingress/poller.ts    轮询逻辑（库函数，可注入依赖，可单测）
```

若 `src/ingress/` 不存在，则放 `src/cli/poller-core.ts` 并在 `directory-structure.md`
允许的边界内（CLI 层可依赖 control/fact/execution）。**不放进 control plane**：
poller 是接入层，不参与状态机决策。

依赖方向：poller → `run-issue`（组合）→ `ingest-issue` / `run-task`；不反向依赖。

## 2. 仓库级 label

### 2.1 迁移

`migrations/1000000000006_repo_issue_label.sql`：

```sql
ALTER TABLE repo
  ADD COLUMN issue_label text NOT NULL DEFAULT 'keel',
  ADD CONSTRAINT repo_issue_label_nonempty CHECK (btrim(issue_label) <> '');
```

- 可加列 + 默认值，既有行自动回填 `keel`，无需单独的数据迁移脚本。
- 约束只拒绝空白，不限制 label 内容（GitHub label 可含空格 / 中文）。

### 2.2 注册入口

`src/cli/register-repo.ts`：

- 新 flag `--issue-label <name>`，缺省 `undefined`。
- 新建 repo：`issue_label = flag ?? 'keel'`。
- 已存在 repo：未传 flag → 保留原值；传了且不同 → UPDATE
  （与 `--local-path` 相同的「不传即保留」语义）。
- 空白值在写库前拒绝（`process.exitCode = 1`），不依赖数据库约束报错。

为什么不放配置文件：`repo` 表已经是仓库注册的唯一事实源，再加一个 config 文件
会引入第二套同步逻辑。

## 3. GitHub 列表能力

`GitHubProvider` 新增：

```ts
export interface ListedIssue {
  readonly number: number
  readonly title: string
  readonly state: 'open' | 'closed'
  readonly isPullRequest: boolean
  readonly labels: readonly string[]
}

export interface IssueList {
  readonly issues: readonly ListedIssue[]
  readonly truncated: boolean
}

async listOpenIssues(
  remoteUrl: string,
  label: string,
  opts?: { readonly maxPages?: number },
): Promise<Result<IssueList>>
```

请求由 `URLSearchParams` 构造，避免 label 里的空格 / 中文拼错：

```
/repos/<slug>/issues?state=open&labels=<label>&per_page=100&page=<n>
```

- **过滤 PR**：issues API 会把 PR 混进来，`pull_request !== undefined` 一律丢弃。
- **分页**：`page` 从 1 递增，返回不足 `per_page` 即停；`maxPages` 缺省 10。
  最后一页恰好满 100 且已到 `maxPages` → `truncated: true`。
- **同轮去重**：按 `number` 去重（分页期间 issue 状态变化可能导致跨页重复）。
- 复用 GHES 子任务的 `parseRemoteUrl` / `request(host, path)`；不新写 host 规则。
- label 无匹配 → 空列表，不是错误。
- 新增纯函数 `issueUrlFor(parsed: ParsedRemote, number: number): string`，
  把 `repo.remote_url` 规范化为 `https://<host>/<owner>/<repo>/issues/<n>`；
  poller 用它调用 `runIssue`，并显式传 `repoId`，避免 SSH remote 与 https remote
  的归一化差异。

## 4. 轮询算法

```
每轮：
  repos = SELECT id, remote_url, default_branch, issue_label
          FROM repo WHERE provider='github'
  for repo in repos:
      page = github.listOpenIssues(repo.remote_url, repo.issue_label)
      for issue in page.issues where !isPullRequest:
          ref = `${owner}/${repo}#${number}`
          status = findTaskStatusByExternalRef(ref)
          if status 终态:            skipped++
          else:
              runIssue({ issueUrl, repoId: repo.id, ci, harness, model, wallClockS })
              ingested/driven++ 或 errors++
  log aggregate
```

- `runIssue` 已包含「ingest + runTask」两段，poller 不复制任何一段逻辑。
- 非终态但已存在的 task：`ingestIssue` 会返回 `created=false`，`runTask` 继续驱动 ——
  正是需求 R5 要的行为。
- 终态判定复用 `TERMINAL_STATUSES`（`src/shared/ids.ts`），不新写集合。
- `findTaskStatusByExternalRef` 用 `feedback(source='github', external_ref)`
  join `task_feedback` / `task` 查询；`external_ref` 由同一个 `ownerRepo()` 生成，
  与 ingest 侧保持一致。

## 5. 幂等与并发

- 数据库唯一键 `feedback(source, external_ref)` 是去重的事实来源；
  `driver.intake` 对同一 feedback 返回既有 task。
- 单进程顺序执行，不引入锁。多实例部署不在本任务范围；
  若未来需要，用 PostgreSQL advisory lock（记录在 `notes`，不提前实现）。
- 同一轮内不并发驱动多个 issue：Agent 驱动是重操作，顺序更容易诊断。

## 6. 信号与生命周期

```ts
export interface PollerDeps {
  readonly listRepos: () => Promise<RepoRow[]>   // RepoRow 含 issue_label
  readonly listIssues: (repo: RepoRow) => Promise<Result<IssueList>>
  readonly taskStatus: (externalRef: string) => Promise<string | undefined>
  readonly runIssue: (issueUrl: string, repoId: string) => Promise<Result<unknown>>
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

## 7. 日志

单行 JSON，字段：

```json
{"ts":"...","event":"poll","repos":3,"scanned":12,"ingested":2,"driven":2,"skipped":10,"errors":0,"truncated":false}
{"ts":"...","event":"repo","repo":"o/r","label":"keel","scanned":4,"truncated":false}
{"ts":"...","event":"issue_error","ref":"o/r#12","kind":"WORKSPACE_ERROR","detail":"..."}
{"ts":"...","event":"poller","state":"stopped"}
```

- `detail` 在写入前过 `redactSecrets`（由 `11-03-git-transport-auth` 在
  `src/fact/github-auth.ts` 提供）：token、base64、`Bearer x` 都替换。
- 不打印 issue body（不可信输入，且可能很大）。
- `repo` 字段用 `owner/repo`（不含 `.git`），与 `external_ref` 一致。

## 8. CLI

`src/cli/index.ts` 增加 `poller` 分支；帮助文本与 README 同步。

参数：

- `--interval <ms>`：正整数，缺省 60000；非法值拒绝（不静默回退）。
- `--ci` / `--model` / `--harness` / `--wall-clock`：复用 `parseCiMode` /
  `resolveHarness` / `resolveModelForHarness` / `parseWallClock`，与 `run-issue`
  同一套，不写第二份。
- 不提供 `--label`：label 的唯一事实源是 `repo.issue_label`。

## 9. 依赖与顺序

```
11-03-ghes-host-support   → parseRemoteUrl / request(host, path)
11-03-git-transport-auth  → redactSecrets / 私有仓库 clone+push 能力
08-29-ingress-poller      → 本任务
```

- 先做 GHES：`listOpenIssues` 直接用 host 感知的请求签名，避免 provider 改两次。
- 再做 git-auth：poller 驱动 `runIssue` 时需要私有仓库凭据，日志脱敏也依赖
  `redactSecrets`。
- 两块未合并前，本任务只写规划，不提前实现 provider 列表能力。

## 10. 测试

- 迁移 / 注册入口：
  - 新 repo 默认 `issue_label='keel'`；
  - `--issue-label` 显式值写入；
  - 已存在 repo 不传 flag 保留原值，传了则更新；
  - 空白值拒绝。
- provider `listOpenIssues`（stub server）：
  - 含 PR 的响应里 PR 被过滤；
  - 两页数据都被返回；
  - 触顶 `maxPages` 时 `truncated: true`；
  - label 含空格 / 中文时 query 正确编码。
- 纯逻辑（注入 deps，不碰数据库）：
  - 三个 repo 各自用自己的 label 调 `listIssues`；
  - 新 issue → 调 `runIssue`；
  - 已终态 task → 不调；
  - 非终态 task → 调；
  - 单个 issue 失败不影响后续；
  - SIGTERM 后下一轮不再扫描。
- e2e（可选）：本地 stub GitHub + 真库，跑一轮断言 task 创建。
