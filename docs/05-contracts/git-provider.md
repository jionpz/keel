# `PullRequestGateway`（Git Provider）

> 创建 PR 的写操作网关。Control Plane 只依赖接口，不依赖具体实现。
> v0.1 的 GitHub 实现：`src/fact/github-provider.ts`。

---

## 0. 这份契约要解决的问题

Keel 把开发流程走到 `S-PR_OPEN` 时要把工作分支的改动提成 PR。
但「创建 PR」是一次**外部写操作** —— 它不属于任何 Plane 的事实写入，
而是对远端托管方（GitHub 等）的调用。副作用必须幂等、必须可重放
（ADR-0003），所以网关被建模成与 `HarnessAdapter` 同级的薄边界。

---

## 1. 接口

```ts
interface PullRequestInput {
  repoId: string
  remoteUrl: string        // https://github.com/owner/repo.git 或 git@github.com:owner/repo.git
  baseBranch: string       // PR 目标分支（通常是 repo.default_branch）
  headBranch: string       // PR 源分支,必须在 ai/* 命名空间
  title: string
  body: string
}

interface PullRequestInfo {
  number: number
  url: string
  created: boolean         // true = 本次新建;false = 复用已有 PR
}

interface PullRequestGateway {
  createPullRequest(input: PullRequestInput): Promise<Result<PullRequestInfo>>
}
```

## 2. 语义

### 2.1 幂等是硬约束

同一 head 分支已有 PR 时必须返回**已有** PR（`created: false`），不得重复创建。
故障恢复（at-least-once 投递）依赖这一点 —— 重放副作用不等于重开 PR。

### 2.2 head 分支白名单

`headBranch` 必须以 `ai/` 开头，否则返回 `PERMISSION_DENIED`。
分支名由 `branchFor(task_id)` 决定（幂等：同 task 同名），
见 `src/fact/git-workspace.ts` 与 `docs/08-cross-cutting.md` §4.1。

### 2.3 已有 PR 的查询按 `owner:branch` 过滤

实测（2026-08-23 验收）：
`owner/repo:branch`（无论是否 URL 编码）GitHub 一律返回空集，
导致幂等查询永远落空、重复调用撞 422。
**必须用 `owner:branch`** —— head 过滤器是 `owner:branch`，不是 `owner/repo:branch`。

---

## 3. 错误语义

| HTTP / 场景 | ErrorKind | retryable | 说明 |
|---|---|---|---|
| 401 / 403 | `AUTH_FAILED` | false | 凭据失效,重试无意义 |
| 404 | `NOT_FOUND` | false | 仓库不存在 |
| 429 / 5xx | `HARNESS_UNAVAILABLE` | true | 暂不可用,可重试 |
| 网络层失败 | `HARNESS_UNAVAILABLE` | true | 不透传 Error 对象（可能含完整 URL） |
| 非 201 的创建响应 | `WORKSPACE_ERROR` | true | 分支冲突等 |

---

## 4. 凭据纪律

- token 只从进程环境 `KEEL_GITHUB_TOKEN` / `GITHUB_TOKEN` 读（`readTokenFromEnv`）;
- 不进 URL、不进 argv、不进事件 payload、不进错误信息;
- `Authorization` header 只存在于本进程内存;
- 缺 token 时所有请求返回 `AUTH_FAILED`。

---

## 5. 边界

- **只做远端写操作**（创建 PR）。克隆 / worktree / commit / push 属 GitWorkspace
  （`src/fact/git-workspace.ts`），不在本契约内。
- **不读 CI 结果** —— 那属于 `CiGateway`（`ci-gateway.md`）。
- 本契约实现 = `src/contracts/git-provider.ts`；验收 = `test:acceptance`
  （真实 GitHub 仓库 + 凭据）。