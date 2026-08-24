# Design — GitHub PR / CI 集成

## 1. 目标接口

新增两个薄接口，放在 `src/contracts/` 下（与现有 contracts 风格一致）：

```ts
// src/contracts/git-provider.ts
export interface PullRequestInput {
  readonly repoId: string
  readonly baseBranch: string
  readonly headBranch: string
  readonly title: string
  readonly body: string
}

export interface PullRequestInfo {
  readonly number: number
  readonly url: string
}

export interface PullRequestGateway {
  /** 幂等：先按 head 分支查已有 PR，存在即返回已有 */
  createPullRequest(input: PullRequestInput): Promise<Result<PullRequestInfo>>
}

// src/contracts/ci-gateway.ts
export interface CiGateway {
  /**
   * 等待/读取 GitHub Checks + Commit Status。
   * 返回 'passed' | 'failed'；超时或不可恢复错误按失败处理。
   */
  waitForCi(input: { readonly repoId: string; readonly headSha: string }): Promise<Result<'passed' | 'failed'>>
}
```

也可以合并为一个 `GitHubProvider`（同时实现两个接口），
但 Control Plane 依赖接口，不依赖具体实现。

## 2. 副作用执行器改动

`EffectContext` 增加可选 `github?: PullRequestGateway`：

```ts
export interface EffectContext {
  // ...现有字段
  readonly github?: PullRequestGateway
}
```

`applyEffects` 中 `CreatePullRequest` 分支：

```
if (ctx.github === undefined) → recordIntent(...)   // 保持现状
else → createPullRequest(c, ctx, effect)
```

`createPullRequest` 内部：
1. 从 `GitWorkspace` 获得 worktree / 裸仓库；
2. push `ai/task-<id>` 分支到远程（幂等）；
3. 调 `github.createPullRequest(...)`；
4. 写 `SideEffectApplied` 或 `SideEffectSkipped`。

## 3. GitWorkspace 增加 push

`GitWorkspace` 目前只有本地裸仓库操作。新增：

```ts
async push(repoId: string, taskId: string, remoteUrl: string): Promise<Result<string>>
```

- 在裸仓库或 worktree 中执行 `git push <remote> <branch>`；
- 不 `--force`；
- 只允许 `ai/*` 分支（校验分支名）；
- 凭据通过环境注入：优先 `gh auth setup-git` 配置的 credential helper，
  或 `GIT_ASKPASS` 指向临时脚本，**不把 token 拼进 URL/argv**。

## 4. GitHubProvider 实现（v0.1 推荐路径）

### 4.1 方案 A：`gh` CLI（推荐）

- 优点：认证由 `gh auth login` / `GH_TOKEN` 管理，不新增依赖，天然避免 token 进 argv。
- 创建 PR：
  ```
  gh pr create --repo <owner/repo> --base <base> --head <head> \
    --title <title> --body <body> --json number,url
  ```
- 查询已有 PR：
  ```
  gh pr list --repo <owner/repo> --head <head> --state all --json number,url
  ```
- 查 CI：
  ```
  gh pr checks <number> --repo <owner/repo> --watch --fail-fast --json state,conclusion
  ```
  或调用 REST 轮询。

### 4.2 方案 B：GitHub REST API（Node 内置 fetch）

- `POST /repos/{owner}/{repo}/pulls`
- `GET /repos/{owner}/{repo}/pulls?head={owner}:{head}`
- `GET /repos/{owner}/{repo}/commits/{head_sha}/check-runs`
- `GET /repos/{owner}/{repo}/commits/{head_sha}/status`
- 请求头 `Authorization: Bearer ${token}`，token 只存在于进程内存。

### 4.3 选择

v0.1 建议**先实现 REST + 可选 `gh`**，因为 CI 里不一定有 `gh`，
而 REST 只需要 token。push 仍用 git + credential helper。

## 5. 编排器 CI 接线

当前 `RunOptions.externalCi?: (taskId) => Promise<'passed'|'failed'>`。
改为：

```ts
export interface RunOptions {
  readonly maxSteps?: number
  /** 真实 CI gateway；不传时保留旧行为（测试/本地模拟） */
  readonly ci?: CiGateway
}
```

在 `S-PR_OPEN` 分支：

```
if (opts.ci === undefined) {
  // 保持可测试的旧路径：没有 gateway 时停在 S-PR_OPEN 或使用 externalCi
}
const headSha = await readHeadSha(taskId)
const result = await opts.ci.waitForCi({ repoId, headSha })
driver.advance(taskId, result === 'passed' ? { type: 'CIPassed' } : { type: 'CIFailed' }, now)
```

`externalCi` 可保留为兼容测试的简易注入，但生产入口应传 `ci`。

## 6. 测试策略

| 层 | 测什么 | 怎么测 |
|---|---|---|
| 单元 | PR 幂等、事件记录、无 provider 退回 intent | fake `PullRequestGateway` + 内存/测试 DB |
| 单元 | push 分支名校验、不 force | 本地 bare repo + fake remote |
| 集成 | 真实 git + fake GitHub HTTP | 本地起一个 stub HTTP server 模拟 GitHub API |
| 验收 | 真实 GitHub PR + CI | 需要用户提供远程仓库与凭据，跑 `pnpm run test:acceptance` |

## 7. 安全注意事项

- token 只在进程环境 / 密钥管理中出现；
- `GitHubProvider` 的错误信息不得包含 Authorization header；
- 事件 payload 只记 PR URL / number / SHA，不记 token；
- 如果 GitHub API 返回 `401/403`，映射为 `AUTH_FAILED`（`retryable=false`），按文档升人工。

## 8. 未验证前的诚实边界

- 在拿到真实远程与凭据前，`GitHubProvider` 可以写，但**必须**标记为“未真实验证”；
- `CreatePullRequest` 未注入 provider 时仍记 `SideEffectIntent`；
- 验收测试中真实路径与本地模拟路径分开，避免把模拟说成真实。
