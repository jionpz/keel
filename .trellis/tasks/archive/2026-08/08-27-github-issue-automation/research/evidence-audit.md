# Evidence Audit — GitHub Issue 自动构建（2026-08-27）

规划前对「已知事实」逐条在代码中核验的结果。所有结论都带 file:line 锚点。

## 1. T-001 现状：表中存在，但整条路径是死的（比预想更死）

- 转移表里 T-001 存在：`from: null, on: ['FeedbackTriaged'], to: 'S-NEW', effects: [CreateTask, LinkFeedback]`
  （`src/control/transition/table.ts:29-38`）。
- **核验发现 1**：`transition()` 的 `fromMatches` 对 `from: null` 直接返回 `false`，注释明说
  「∅ 只用于创建 Task，不参与已有 Task 的转移」（`src/control/transition/index.ts:30-32`）。
  即使 task 存在，T-001 也永远不会被 `transition()` 命中。
- **核验发现 2**：`driver.advance` 第一步 `SELECT ... FROM task WHERE id=$1`，查不到直接
  `NOT_FOUND`（`src/control/driver/driver.ts:74-81`）。task 尚不存在时根本进不了 advance。
- **核验发现 3**：`effects.ts` 中 `CreateTask` / `LinkFeedback` 落在 `recordIntent` 分支
  （`src/control/driver/effects.ts:533-539`），只写 `SideEffectIntent` 事件。
- **结论**：实现 T-001 不是「补一个 effect」，而是需要一条**新的入口路径**
  （driver 上的 intake 方法），在单事务内：建 task 行 → 建 task_feedback → 写
  `TaskStatusChanged{transition:'T-001'}` 事件（满足 I4）。转移表行本身可保留为事实来源，
  由 intake 路径直接引用 T-001 的 effects。

## 2. Schema / 授权现状

- `feedback.source` CHECK 只有 `web|email|api|manual`，无 `github`
  （`migrations/1000000000000_initial-schema.sql:53`）。需要迁移。
- 去重机制现成：`UNIQUE (source, external_ref)`（同文件 :58）。
  `external_ref` 用 `owner/repo#<number>` 即可幂等。
- **核验发现 4（授权缺口）**：`keel_control` 对 feedback 只有 SELECT（I6，同文件 :248），
  **没有任何角色拥有 feedback 的 INSERT**。docs/03-domain-model.md §4 矩阵定义了
  「外部 Ingress」列（feedback: INSERT+SELECT），但迁移中不存在对应角色。
  `asOwner` 明确标注「仅用于测试装置与迁移，生产代码不应使用」（`src/fact/db.ts:64`）。
  → 需要新建 `keel_ingress` 角色 + GRANT，把文档矩阵落成 schema。
- task 建行所需字段：`id/status/title/repo_id/base_branch/work_branch`
  （同迁移 :62-84）；`keel_control` 有 task INSERT/UPDATE 和 task_feedback INSERT（:249-250），
  所以 triage（建 task）本身可以由 control 角色完成。
- 分支名事实来源：`branchFor(taskId)` → `ai/task-<id8>`（`src/fact/git-workspace.ts`，
  验收测试 `src/acceptance/v01-criterion.acceptance.test.ts:84` 同款）。

## 3. CLI 现状

- 子命令只有 `timer-worker` / `run-task` / `status`（`src/cli/index.ts:40-49`）。无 ingest。
- **核验发现 5**：`run-task` 构造 `WorkflowDriver(policy, binding)` 时**没有传第三个参数
  github gateway**（`src/cli/run-task.ts:64`），所以 CLI 路径下 `CreatePullRequest` 只会
  记 intent；CI 也只走 `externalCi` 模拟（`--ci` 缺省 `passed`，:36,72-74）。
  真实 PR/CI 只在验收测试里直连过 provider，CLI 从未接线。
- 编排 loop 对真实 CI 的支持**已经存在**：`opts.ci`（CiGateway）优先于 `externalCi`，
  会读 headSha + `waitForCi`（`src/control/orchestrator/loop.ts:174-197`）。
  Phase 2 主要是 CLI 接线，不是 loop 改造。

## 4. GitHubProvider 现状

- 实现 `PullRequestGateway` + `CiGateway`：createPullRequest（幂等，按 head 分支查重，
  仅允许 `ai/*` 分支）、waitForCi（Checks + Commit Status 归并，无 CI 仓库返回 passed）
  （`src/fact/github-provider.ts`）。
- token 从 `KEEL_GITHUB_TOKEN` / `GITHUB_TOKEN` 读，不进 URL/argv/日志（:40-42,74-80）。
- `ownerRepo()` 解析器现成，可复用于 issue URL 解析（:50-57）。
- **没有任何读 issue 的 API**。`rg -i 'webhook|ingest|issue'` 在 src/ 下零命中。
  需要新增 `getIssue()`（GET /repos/{slug}/issues/{n}）。注意 issues API 会把 PR 也
  当 issue 返回（有 `pull_request` 字段），必须排除。
- 真实 PR/CI 验收已通过（2026-08-24）：`src/acceptance/github-pr.acceptance.test.ts`，
  环境门槛 `KEEL_TOKEN` + `KEEL_TEST_REMOTE_REPO`，不在默认 `pnpm run check` 内。

## 5. 测试如何绕过 T-001

- `v01-criterion.acceptance.test.ts` 的 `seed()` 用 `asOwner` 直接 INSERT
  repo/feedback/task(S-NEW)/task_feedback（:72-90），事件流从 T-002 开始
  （断言 `transitions[0] === 'T-002'`，:183）。v0.1 判据里「一条真实反馈进入系统」
  的**进入**环节从未被真实实现 —— 正是本任务要闭合的缺口。

## 6. 调度 / 队列现状

- loop 是同步单 task 驱动，注释明说「durable timer 与 work queue 属后续子任务」
  （`src/control/orchestrator/loop.ts:13-15`）。timer 表只服务 clarification TTL 与
  run 墙钟。守护进程轮询 + 队列应推迟（roadmap §4 用触发条件而非时间表）。

## 7. Roadmap / 边界约束（docs/09-roadmap.md）

- v0.1 判据：真实反馈 → 无人干预 S-NEW→S-DONE → CI 通过的 PR + 事件流可重建（§1）。
- Non-goals：**自动合并 PR 明确不做**（保留人工闸门，§2.1）；多项目/多租户不做（单仓库）。
- 「UI 不做，事件流 + CLI 足够验证闭环」→ CLI 优先于 webhook 与 roadmap 纪律一致。
- Policy 现状：DEFAULT_RULESET 高风险 RFC → `human_review`（T-013 → S-HUMAN_REVIEW），
  这是设计内行为，不是缺陷；自动路径只对低风险 RFC 全通。

## 8. 验证命令

- `pnpm run check` = lint + typecheck + boundaries + check:generated + check:transitions +
  check:purity + test（`package.json:26`）。改转移表语义时 `check:transitions` 会比对
  docs/04-state-machine.md（C4）。
- 真实验收：`pnpm run test:acceptance`（需要 token + 远程仓库，模型变差可能导致波动）。
