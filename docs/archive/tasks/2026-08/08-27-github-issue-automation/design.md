# GitHub Issue 自动构建 — 技术设计

前置阅读：`prd.md`（决策 D1–D7）、`research/evidence-audit.md`（file:line 证据）。

## 1. 总体数据流

```
GitHub Issue (label: keel)
   │  keel ingest-issue <url>
   ▼
GitHubProvider.getIssue()          ← 新增（只读，token 纪律同 request()）
   │  label 闸门 / 排除 PR
   ▼
[keel_ingress] INSERT feedback     ← 新角色；source='github', external_ref='owner/repo#N'
   │  UNIQUE(source, external_ref) 天然去重
   ▼
[keel_control] driver.intake()     ← 新入口；T-001 真实化（单事务）
   │  INSERT task(S-NEW) + task_feedback + TaskStatusChanged{T-001}
   ▼
keel run-task <id> --ci real       ← 接线 GitHubProvider（PR gateway + CI gateway）
   │  既有 loop：T-002 → … → T-021 CreatePullRequest → T-024 CIPassed
   ▼
S-DONE + 真实 PR（CI 通过）
```

`keel run-issue` = 上图两段的组合命令。

## 2. 架构与边界

### 2.1 T-001 的实现形态（核心设计点）

约束（evidence-audit §1）：`transition()` 对 `from: null` 恒不匹配，是**刻意设计**
（「∅ 只用于创建 Task」）；`driver.advance` 要求 task 已存在。因此不改 `transition()` 的
纯函数语义，而是在 `WorkflowDriver` 上新增一个平行入口：

```ts
// src/control/driver/driver.ts
async intake(input: IntakeInput, now: string): Promise<Result<IntakeOutcome>>

interface IntakeInput {
  readonly feedbackId: string
  readonly title: string        // 取 issue title，截断到合理长度
  readonly repoId: string
  readonly baseBranch: string   // 取 repo.default_branch
}
// IntakeOutcome: { taskId, created: boolean }
```

行为（单个 keel_control 事务内，对齐 I4「状态变更必然伴随事件」）：

1. 幂等检查：`SELECT task_id FROM task_feedback WHERE feedback_id=$1` → 已有则返回
   `{taskId, created:false}`，并写 `SideEffectSkipped{kind:'CreateTask'}` 事件。
2. 生成 taskId；从转移表取 T-001 行（`TASK_TRANSITIONS.find(r => r.id==='T-001')`），
   effects 仍是事实来源。
3. 执行 effects：
   - `CreateTask`：`INSERT INTO task (id,status,title,repo_id,base_branch,work_branch)
     VALUES ($1,'S-NEW',...)`，`work_branch = branchFor(taskId)`（复用
     `src/fact/git-workspace.ts` 的单一事实源，与验收测试同款 `ai/task-<id8>`）。
   - `LinkFeedback`：`INSERT INTO task_feedback ... ON CONFLICT DO NOTHING`。
   - 两者都写 `SideEffectApplied` 事件（event.task_id FK 要求 task 行先 INSERT，顺序天然满足）。
4. 写 `TaskStatusChanged {from:null, to:'S-NEW', transition:'T-001', event:'FeedbackTriaged'}`。

**effects.ts 的改动**：`CreateTask` / `LinkFeedback` 从 `recordIntent` 分支移出。由于
`applyEffects` 的 `EffectContext` 以「task 已存在」为前提（taskId 只是 string），有两个可选
实现位置：

- **方案 A（推荐）**：intake 不走 `applyEffects`，在 `intake()` 内直接实现这两个 effect 的
  真实版本，`effects.ts` 里这两个 case 改为抛错（「CreateTask 只能经 intake 路径执行」）。
  理由：CreateTask 需要 feedback/repo 上下文，塞进 EffectContext 会让所有其他 effect 背上
  不相关字段；且 T-001 是唯一使用者。
- 方案 B：扩展 EffectContext 携带 intake 上下文，走统一 applyEffects。放弃：为单一调用方
  泛化共享契约，违反 code-reuse guide 的「有真实第二调用方再抽象」。

`CancelRun/RecordReason/MaybeAutoMerge` 维持 recordIntent 不变（明确不在本任务范围）。

**C4 一致性**：转移表 T-001 行的 from/on/to/effects 全部不动，
`scripts/check-transition-table.ts` 与 docs/04 的比对不受影响。

### 2.2 迁移（`migrations/1000000000003_github_ingress.sql`）

```sql
-- Up
ALTER TABLE feedback DROP CONSTRAINT feedback_source_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_source_check
  CHECK (source IN ('web','email','api','manual','github'));

DO $role$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='keel_ingress') THEN
    CREATE ROLE keel_ingress NOLOGIN;
  END IF;
END $role$;
-- GRANT keel_ingress TO CURRENT_USER（同初始迁移的 DO 块写法）
GRANT USAGE ON SCHEMA public TO keel_ingress;
GRANT SELECT, INSERT ON feedback TO keel_ingress;
-- Down：撤销 GRANT + 还原 CHECK（角色留存，与初始迁移对 role 的处理一致）
```

- 约束名以 `\d feedback` 实测为准（node-pg-migrate 默认命名可能是
  `feedback_source_check`，实现时核实）。
- **不**给 keel_ingress 授 repo/task 权限：repo 解析与 task 创建都发生在 keel_control
  阶段，与 docs/03 §4 矩阵严格一致。
- 同步更新 docs/03-domain-model.md §4：矩阵「外部 Ingress」列加注「= keel_ingress 角色」。
- `src/fact/db.ts`：`KeelRole` 联合类型加 `'keel_ingress'`（asRole 复用，无其他改动）。
- `invariants.test.ts` 补反例：keel_ingress 不能写 task/artifact/event；keel_control
  仍不能写 feedback。

### 2.3 GitHubProvider 扩展

```ts
export interface IssueInfo {
  readonly number: number
  readonly title: string
  readonly body: string          // '' 代替 null
  readonly labels: readonly string[]
  readonly state: 'open' | 'closed'
  readonly isPullRequest: boolean // 响应含 pull_request 字段
}
async getIssue(remoteUrl: string, issueNumber: number): Promise<Result<IssueInfo>>
```

- 走既有 `request()`（错误映射、token 纪律不变）。
- URL 解析新增 `parseIssueUrl(url): Result<{remoteUrl, number}>`，支持
  `https://github.com/owner/repo/issues/123`；内部复用 `ownerRepo()` 正则思路，
  不写第二份 owner/repo 正则（#1-11 教训）。
- 单测走 stub HTTP server（与 github-provider.test.ts 同模式）：label 提取、
  pull_request 排除、body=null → ''。

### 2.4 CLI

新增 `src/cli/ingest-issue.ts`、`src/cli/run-issue.ts`、`src/cli/register-repo.ts`，
在 `src/cli/index.ts` 注册。参数解析复用 `parseArgs`。

**ingest-issue 流程**：

1. `parseIssueUrl` → `{remoteUrl, number}`。
2. repo 解析（keel_control SELECT）：按 remote_url 匹配（归一化 `.git` 后缀与末尾 `/`）；
   `--repo <uuid>` 可显式指定。查不到 → 报错并提示 `keel register-repo`。
3. `getIssue` → 闸门：`state==='open'`、`!isPullRequest`、labels 含目标 label
   （缺省 `keel`，`--label` 覆盖）。不过闸 → 打印原因，退出码 1，零写入。
4. `asRole('keel_ingress')`：`INSERT INTO feedback (id,source,external_ref,body)
   VALUES ($1,'github','owner/repo#N', title+'\n\n'+body) ON CONFLICT DO NOTHING`；
   冲突时 SELECT 既有 feedback id。
5. `driver.intake(...)` → 打印 taskId（created / reused）。

**run-task 真实模式（改造）**：`--ci` 增加 `real` 取值：

```ts
const github = ci === 'real' ? new GitHubProvider() : undefined
new WorkflowDriver(policy, binding, github)          // 第三参：真实 CreatePullRequest
runTaskToCompletion(taskId, deps, {
  maxSteps,
  ...(ci === 'real' ? { ci: github } : { externalCi: async () => ci }),
})
```

`--ci real` 且无 token → 启动即报错（AUTH_FAILED 提示设置 KEEL_GITHUB_TOKEN），
不进 loop —— 防止跑完 develop 才发现建不了 PR。

**run-issue** = ingest-issue 的 1–5 + run-task 主体的组合（提取共享函数，不复制粘贴）。
结束时查 `event` 表 `SideEffectApplied{kind:'CreatePullRequest'}` 的 payload 取 pr_url 打印；
终态非 S-DONE（如 S-HUMAN_REVIEW / S-REJECTED）时如实打印状态与原因事件，退出码 0
（编排如实完成）；编排错误才非 0。

## 3. 兼容性

- 既有测试的 seed 路径（asOwner 直插 S-NEW）不受影响 —— intake 是新增入口。
- `--ci passed|failed` 语义与缺省值不变；`run-task` 无 token 环境行为不变。
- 迁移可 down；`keel_ingress` 角色留存（与初始迁移对集群级角色的处理一致）。
- 转移表零改动；`check:transitions`、`check:purity`（intake 不进 transition() 纯函数域）
  均不受影响。

## 4. 安全

- Issue body 是不可信输入（feedback.body 既有纪律，prompt injection 主入口）：
  只作为参数化 SQL 的值进 feedback.body，绝不进命令行/模板拼接。
- label 闸门 = 授权边界：开 Issue 人人可为，打 label 需要 triage 权限。
- token 纪律沿用 github-provider.ts（不进 URL/argv/事件/错误信息）。
- PR 仍只允许 `ai/*` 分支（既有 createPullRequest 守卫）。

## 5. 失败与回滚

- ingest 中途失败：feedback INSERT 与 intake 是两个事务；feedback 已插但 task 未建时，
  重跑 ingest-issue 幂等续走（feedback 冲突 → 复用 id → intake 继续）。
- intake 事务内任一步失败 → 整体回滚，无半建 task。
- run-issue 真实模式的重放安全依赖既有幂等：CreateBranch/CreatePullRequest/CreateRun
  均已幂等（docs/07 §3.1）。
- 回滚点：迁移 down；新 CLI 文件独立，可整体 revert 不触及既有路径。

## 6. 测试策略

| 层 | 内容 | 门 |
|---|---|---|
| 单测 | parseIssueUrl；getIssue（stub HTTP：label/PR 排除/null body）；intake 幂等与事务原子性；effects CreateTask/LinkFeedback 真实化；keel_ingress 授权反例 | `pnpm run check` |
| 集成 | ingest-issue → S-NEW task → 既有 loop 可驱动（fake 场景，不打真实 API） | `pnpm run check` |
| 验收（opt-in） | 真实 Issue（gh/API 创建带 label）→ run-issue --ci real → S-DONE + 真实 PR + CI passed + 事件流 T-001 起 T-024 终；收尾关 PR、删分支、关 Issue | `pnpm run test:acceptance`（需 token + KEEL_TEST_REMOTE_REPO） |

已知风险：真实验收受模型变差影响（OMP 会话可能在中间阶段不收敛）——与既有
v01-criterion 验收同性质，不进默认 check，失败时按「诚实失败」纪律报告而非重试掩盖。

## 7. 子任务划分

| 子任务 | slug | 交付物 | 可独立验证 |
|---|---|---|---|
| 1 | `issue-intake` | 迁移 + getIssue + intake/T-001 真实化 + ingest-issue/register-repo CLI | AC1–AC4 |
| 2 | `run-issue-e2e` | run-task --ci real 接线 + run-issue CLI + opt-in 真实验收 | AC5–AC7 |
| 3（暂缓） | `issue-poll-daemon` | 轮询守护 + work queue | 触发条件见 prd Phase 3 |

子任务 2 依赖 1（依赖写在子任务 2 的 prd/implement 中，非树形暗示）。
