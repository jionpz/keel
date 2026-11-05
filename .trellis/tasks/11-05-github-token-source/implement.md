# 实施计划：GitHub token 来源与启动期校验

> 设计见 `design.md`；PRD 见 `prd.md`。小步提交点按「解析器 → 消费方 → 入口 → 文案」排列。

## 1. 解析器

- [x] `src/fact/github-auth.ts` 新增 `TokenResolveDeps`、`resolveGitHubToken(host?, deps?)`。
  - `execFile('gh', ['auth','token','--hostname', host])`，`timeout: 5000`，`maxBuffer` 足够小值。
  - 任何失败 → `undefined`；不把 stderr 带出。
  - env 空白值跳过。
- [x] `src/fact/github-auth.test.ts`：优先级、空白 env 回落 gh、gh 失败/ENOENT、host 透传。
  **所有用例注入 `runGh`，不得调用真实 gh。**

## 2. 消费方

- [x] `GitHubProvider`：
  - `GitHubProviderOptions` 增加 `tokenResolver?`；构造时保存。
  - `request(host)` 改为 `await this.tokenFor(host)`；`headers(token)` 接收 token；
    按 host 缓存；显式 `opts.token !== undefined` 时不走 resolver。
  - `AUTH_FAILED` 文案更新为三来源 + `gh auth login`。
- [x] `GitWorkspace`：
  - `GitWorkspaceOptions` 增加 `tokenResolver?`。
  - `execGit(..., { auth })` 解析 remote host → await resolver → `authEnvFor`；
    按 host 缓存，并把 token 加入 `secrets()` 的集合。
  - 无 token 时不构造 auth env（保持现有调用形态）。
- [x] 对应测试：provider 按 host 解析/缓存/显式 token 覆盖；git-workspace 无 env + 注入 resolver
  仍生成 `GIT_CONFIG_*`，且 gh 来源 token 被脱敏。

## 3. 入口预检

- [x] `src/cli/run-issue.ts`：`resolveCiGateway` 之前（或内部）用 `parseIssueUrl` 取 host，
  `await resolveGitHubToken(host)`；无值 → `AUTH_FAILED`，在 `ingestIssue` 之前返回。
  注入 `opts.github` 时跳过真实解析。
- [x] `src/cli/poller.ts`：参数校验后、创建 provider 前，`loadGithubRepos()`（或注入的
  `listRepos`）→ `parseRemoteUrl` 唯一 host → 逐个 resolve；任一缺失 → 退出码 1，
  文案列出 host 与两种修复命令。保留循环内 live `listRepos`。
- [x] `src/cli/run-task.ts`：
  - `resolveCiGateway(ci, host?)` 改 async；`ci !== 'real'` 时不做任何解析。
  - `runTask` 在 `loadTaskWorkspace` 前调用 `loadTaskRemoteUrl(taskId)`（新助手，单条 SELECT），
    取 host 后创建 gateway。`task-workspace.ts` 导出该助手。
  - `run-issue` 的早期 gateway 校验传 issue host；`runTask` 内再次校验用 repo host。
- [x] CLI 测试：三个入口各补「env 空 + resolver 无值 → 零写入失败」与「resolver 有值 → 继续」。
  使用注入点，**不依赖开发机 gh 登录态**。
- [x] 注入面：`RunIssueOptions` / `RunTaskOptions` / `PollerMainDeps` 增加 `tokenResolver?`，
  现有 `--ci real` 缺 token 用例改为显式传 `async () => undefined`。

## 4. 文案与文档

- [x] 更新 `run-task` / `run-issue` / `poller` 帮助文案：`--ci real` 凭据来源三选一。
- [x] 更新 `.trellis/spec/backend/github-provider.md`：token 来源优先级、启动期校验位置、
  传输层按 host 解析、脱敏集合包含 gh 来源 token。

## 5. 验证

- [x] `pnpm run check`
- [x] 定向：`pnpm vitest run src/fact/github-auth.test.ts src/fact/github-provider.test.ts src/fact/git-workspace.test.ts src/cli/run-issue.test.ts src/cli/run-task.test.ts src/cli/poller.test.ts`
- [x] 手工反例（不提交）：`env -u KEEL_GITHUB_TOKEN -u GITHUB_TOKEN PATH=/usr/bin:/bin pnpm tsx src/cli/run-issue.ts <url>`
  应报 AUTH_FAILED 且不 ingest；`gh` 可用时应能进入 ingest。

## 回滚点

- 解析器 + 消费方（步骤 1-2）与入口预检（步骤 3）分开提交；回滚步骤 3 即恢复旧的启动门槛，
  回滚步骤 1-2 即恢复纯 env 读取，无表结构 / 事件变化。
