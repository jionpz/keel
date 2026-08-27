# GitHub Issue 自动构建

## Goal

用户在 GitHub 上提交一个 Issue 后，Keel 自动接手：Issue → feedback 落库 → T-001 建 Task →
真实编排（PM → … → develop → QA → review）→ 真实 PR → 真实 CI 通过 → S-DONE。

用户价值：闭合 v0.1 判据（docs/09-roadmap.md §1）中从未真实实现的**进入**环节。
当前闭环依赖测试用 `asOwner` 直接 seed task 到 S-NEW（见 research/evidence-audit.md §5），
「一条真实的用户反馈进入系统」这半句是空的。本任务做完后，一条真实 GitHub Issue
可以在无人干预下产出一个 CI 通过的 PR。

## Background（已核验事实）

完整证据链见 `research/evidence-audit.md`。对规划起决定作用的四条：

1. **T-001 整条路径是死的**：`transition()` 对 `from: null` 恒不匹配
   （`src/control/transition/index.ts:30-32`），`driver.advance` 要求 task 已存在
   （`src/control/driver/driver.ts:74-81`），`CreateTask`/`LinkFeedback` 只 recordIntent
   （`src/control/driver/effects.ts:533-539`）。需要新的 intake 入口，不是补一个 effect。
2. **schema 有两个缺口**：`feedback.source` CHECK 无 `github`
   （`migrations/1000000000000_initial-schema.sql:53`）；没有任何角色拥有 feedback 的
   INSERT —— docs/03 §4 的「外部 Ingress」列未落成角色。
3. **CLI 从未接线真实 PR/CI**：`run-task` 不传 github gateway 给 WorkflowDriver
   （`src/cli/run-task.ts:64`），CI 走 `--ci passed` 模拟。但编排 loop 对真实 CiGateway
   的支持已存在（`src/control/orchestrator/loop.ts:174-197`），GitHubProvider 真实
   PR/CI 验收已于 2026-08-24 通过。
4. **GitHubProvider 没有读 Issue 的 API**；`ownerRepo()` URL 解析器可复用；
   feedback 表 `UNIQUE(source, external_ref)` 提供现成去重。

## Key Decisions（已定，含权衡）

| # | 决策 | 选择 | 权衡 |
|---|---|---|---|
| D1 | 接入机制 | **CLI `keel ingest-issue` 先行，webhook 推迟** | webhook 需要 HTTP server + 签名校验 + 公网端点，src/ 下目前零 HTTP 服务代码；roadmap 明说「事件流 + CLI 足够验证闭环」。代价：不是推送式，需要人（或 Phase 3 的 poller）触发 |
| D2 | Label 闸门 | **只处理带 `keel` label 的 Issue**（`--label` 可改名） | 任何人都能开 Issue，但打 label 需要仓库 triage 权限 —— label 是唯一现成的授权边界，同时也是 prompt injection 的第一道过滤。代价：需要维护者手动打标 |
| D3 | 目标仓库 | **单个预注册 repo**（repo 表已有行；新增 `register-repo` 便利命令） | 与 roadmap Q4「v0.1 单仓库单项目」一致。多 repo 路由推迟。代价：ingest 前必须先注册 |
| D4 | 人工审核 | **接受 Policy 拦截**：高风险 RFC → S-HUMAN_REVIEW 是设计内终点，run-issue 如实报告并停止 | 保留 v0.1 的人工闸门（roadmap §2.1 明确不做自动合并/全自动高危路径）。代价：只有低风险 Issue 能全自动到 S-DONE |
| D5 | 真实 CI 触发方式 | **显式 `--ci real`**，缺省仍是 `passed`（模拟） | 避免默认行为悄悄打真实 GitHub API / 建真实 PR。代价：全真实闭环要多打一个 flag |
| D6 | Ingress 授权 | **新建 `keel_ingress` 角色**（feedback INSERT+SELECT），把 docs/03 §4 矩阵落成 schema | 复用 keel_control 会违反矩阵（control 对 feedback 刻意只读）；用 asOwner 违反 db.ts 的纪律注释。代价：多一个角色 + 一次迁移 |
| D7 | Issue → task 的对应 | 1 Issue = 1 feedback = 1 task；`external_ref = owner/repo#N` 天然去重，重复 ingest 返回既有 task | 不支持一 Issue 多 task / 增量评论回灌（推迟） |

## Requirements

### Phase 1 — Issue Intake（子任务 issue-intake）

- R1 迁移：`feedback.source` CHECK 增加 `github`；新建 `keel_ingress` 角色并
  GRANT INSERT, SELECT ON feedback；带 down migration。
- R2 `GitHubProvider.getIssue(remoteUrl, number)`：读标题/正文/labels/state，
  排除 pull_request 型条目；凭据纪律与现有 request() 一致。
- R3 T-001 真实化：driver 新增 intake 入口（单事务：INSERT task(S-NEW,
  work_branch=branchFor) → INSERT task_feedback → `TaskStatusChanged{transition:'T-001'}`
  事件）；`effects.ts` 中 CreateTask/LinkFeedback 从 recordIntent 变为真实实现；
  幂等：同 feedback 已有 task 时复用。转移表 T-001 行保持不动（C4 检查不受影响）。
- R4 `keel ingest-issue <issue-url> [--label keel] [--repo <id>]`：解析 URL →
  label 闸门 → 以 keel_ingress 落 feedback → 以 keel_control 走 intake 建 task →
  输出 taskId。重复 ingest 幂等返回既有 task。
- R5 `keel register-repo <remote-url> [--default-branch main]`：便利命令，
  幂等（按 remote_url 查重）。
- R6 Issue 正文按不可信输入处理：只进 feedback.body（既有 prompt-injection 纪律），
  不进任何命令拼接。

### Phase 2 — run-issue 全真实闭环（子任务 run-issue-e2e）

- R7 `run-task` 接线真实模式：`--ci real` 时构造 GitHubProvider，作为第三参传给
  WorkflowDriver（真实 CreatePullRequest）并作为 `opts.ci` 传给 loop（真实 waitForCi）；
  `--ci passed|failed` 行为不变。
- R8 `keel run-issue <issue-url> [--ci real|passed|failed] [--label keel] [--max-steps N]`：
  组合 ingest + run-task；结束时打印终态与 PR URL（从 CreatePullRequest 的
  SideEffectApplied 事件读取）。
- R9 opt-in 真实验收测试（模式同 github-pr.acceptance.test.ts，不进默认 check）：
  在 KEEL_TEST_REMOTE_REPO 上建带 label 的真实 Issue → run-issue → 断言 S-DONE +
  真实 PR + CI passed + 事件流可重建（transitions 起于 T-001）。

### Phase 3 — 守护进程轮询 + 工作队列（**本轮不做**，仅立项）

- 推迟依据：loop 注释明确「work queue 属后续子任务，两件事应分开验证」；
  roadmap §4 用触发条件推进。触发条件：Phase 1+2 落地后，出现「Issue 到达但没人跑
  CLI」的真实频次压力。

## Acceptance Criteria

- [x] AC1（进入路径）：对已注册 repo 上一个带 `keel` label 的 Issue 执行
  `keel ingest-issue <url>`，产生 `feedback(source='github', external_ref='owner/repo#N')`
  与 S-NEW task（task_feedback 关联）；事件流含 `TaskStatusChanged{transition:'T-001'}`，
  且 CreateTask/LinkFeedback 以 `SideEffectApplied`（非 `SideEffectIntent`）落账。
- [x] AC2（幂等）：对同一 Issue 重复 ingest 不产生第二条 feedback/task，命令输出既有
  taskId，退出码 0。
- [x] AC3（闸门）：无目标 label 的 Issue、或 pull_request 型条目 → 拒绝并说明原因，
  数据库零写入。
- [x] AC4（衔接既有闭环）：ingest 产生的 task 不经任何 seed SQL，直接
  `keel run-task <id> --ci passed` 可驱动到终态（T-002 起的既有路径不回归）。
- [ ] AC5（全真实，Phase 2）：`keel run-issue <url> --ci real` 在测试仓库上到达 S-DONE，
  存在真实 PR 且 CI passed，命令输出 PR URL；`readEvents` 重建的 transitions 以 T-001 起、
  T-024 终。
  提示词「原样采用」+ 校验 4b（`feedback-constraints`）+ `wallClockS` 透传已落地
  （见 commits `c759eb5` / `6954c52`）。第三次真实跑（墙钟 600s）仍未到 S-DONE：
  rfc_draft 两次超时后 **T-031 升人工**。AC5 仍未关。见下方验收记录。
- [x] AC6（人工闸门如实）：Policy 判高风险的 Issue 停在 S-HUMAN_REVIEW，run-issue 如实
  报告该状态（不伪造成功，不无限等待）。
- [x] AC7（质量门）：`pnpm run check` 全绿（含既有 248 测试 + 新增单测/集成测试）；
  真实验收测试 opt-in 运行通过（入口路径；AC5 全自动到 PR 仍待模型给出 low/low）。

### 真实验收记录

| 日期 | 命令 | 结果 |
|---|---|---|
| 2026-08-27 | `test:acceptance` + `KEEL_TEST_REMOTE_REPO=jionpz/keel` | **入口 OK**：T-001 + github feedback；终态 **S-HUMAN_REVIEW**（Policy，~472s）。github-pr / session-milestone 绿。v01/merge 亦因模型波动未到 S-DONE。AC5 未关。 |
| 2026-08-27（第二次，仅 `issue-e2e`） | `pnpm vitest run --config vitest.acceptance.config.ts src/acceptance/issue-e2e.acceptance.test.ts` | **入口再次 OK**，终态仍 **S-HUMAN_REVIEW**（580s）。路径：`T-001 → T-002 → T-004 → T-030 → T-030 → T-011 → T-013`。归因已查明**不是 Policy 缺陷**：`PolicyEvaluated{decision:'human_review', default_applied:false}`，命中 P1（`risk=='high'`）—— 模型自己写的 `rfc.policy_facts` 是 `{risk:'high', complexity:'high', estimated_files_changed:0}`，而 Issue 正文明确要求 low/low/1 且只改 README 一行。即模型未遵循约束，**非规则集问题**（故未按纪律放宽 Policy）。另有 rfc_draft 阶段 **2 次 RunTimeout**（T-030 自环重试），第 3 次才产出 RFC。收尾干净：Issue 已关、无 PR、未推分支。AC5 仍未关；本次作为 AC6 证据。 |
| 2026-08-27（第三次，`wallClockS=600`） | 同上 + 提示词/4b 已合入 | 测试用例**绿**，但走的是 **AC6 早退**：路径 `T-001 → T-002 → T-004 → T-030 → T-030 → T-031`（rfc 两次超时后重试耗尽升人工）。**未产出 PR，AC5 仍未关**。 |

## Out of Scope

- Webhook / HTTP 服务接入（推迟到 Phase 3 之后按需评估）
- 守护进程轮询、work queue、并发调度（Phase 3 立项，本轮不实现）
- 多 repo 路由 / 多租户（roadmap §2.1 non-goal）
- 自动合并 PR（roadmap §2.1 明确长期保留人工闸门）
- Issue 评论回灌（澄清问答走 GitHub 评论）、向 Issue 回帖 PR 链接
- GitLab provider
- 修改 Policy 规则集放宽高风险自动路径
