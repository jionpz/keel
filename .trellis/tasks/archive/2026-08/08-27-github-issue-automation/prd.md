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
- [x] AC5（全真实，Phase 2）：`keel run-issue <url> --ci real` 在测试仓库上到达 S-DONE，
  存在真实 PR 且 CI passed，命令输出 PR URL；`readEvents` 重建的 transitions 以 T-001 起、
  T-024 终。
  第七次真实跑（2026-08-28，Cloud Agent + fine-grained PAT + OPENCODE + omp 18.0.9）**通过**：
  路径 `T-001 → T-002 → T-004 → T-011 → T-012 → T-017 → T-018 → T-021 → T-024`，
  PR https://github.com/jionpz/keel/pull/45，耗时 263s，**且 T-024 经真实 CI 核对**
  （head SHA 上两条 check 15:57:21 / 15:57:29 completed=success，T-024 在 15:57:32 才流出）。
  提示词/4b 同源改动（`9a26b16`）经本次验证有效。
  ⚠️ 第五、六次的 T-024 是**假绿**（CI 未开跑就判通过），已在第六次查明并修复，见下方记录。
- [x] AC6（人工闸门如实）：Policy 判高风险的 Issue 停在 S-HUMAN_REVIEW，run-issue 如实
  报告该状态（不伪造成功，不无限等待）。
- [x] AC7（质量门）：`pnpm run check` 全绿（2026-08-28：337 passed / 4 skipped）；
  真实验收 `issue-e2e` opt-in **AC5 通过**（2026-08-28，见下方记录）。

### 真实验收记录

| 日期 | 命令 | 结果 |
|---|---|---|
| 2026-08-27 | `test:acceptance` + `KEEL_TEST_REMOTE_REPO=jionpz/keel` | **入口 OK**：T-001 + github feedback；终态 **S-HUMAN_REVIEW**（Policy，~472s）。github-pr / session-milestone 绿。v01/merge 亦因模型波动未到 S-DONE。AC5 未关。 |
| 2026-08-27（第二次，仅 `issue-e2e`） | `pnpm vitest run --config vitest.acceptance.config.ts src/acceptance/issue-e2e.acceptance.test.ts` | **入口再次 OK**，终态仍 **S-HUMAN_REVIEW**（580s）。路径：`T-001 → T-002 → T-004 → T-030 → T-030 → T-011 → T-013`。归因已查明**不是 Policy 缺陷**：`PolicyEvaluated{decision:'human_review', default_applied:false}`，命中 P1（`risk=='high'`）—— 模型自己写的 `rfc.policy_facts` 是 `{risk:'high', complexity:'high', estimated_files_changed:0}`，而 Issue 正文明确要求 low/low/1 且只改 README 一行。即模型未遵循约束，**非规则集问题**（故未按纪律放宽 Policy）。另有 rfc_draft 阶段 **2 次 RunTimeout**（T-030 自环重试），第 3 次才产出 RFC。收尾干净：Issue 已关、无 PR、未推分支。AC5 仍未关；本次作为 AC6 证据。 |
| 2026-08-27（第三次，`wallClockS=600`） | 同上 + 提示词/4b 已合入 | 测试用例**绿**，但走的是 **AC6 早退**：路径 `T-001 → T-002 → T-004 → T-030 → T-030 → T-031`（rfc 两次超时后重试耗尽升人工）。**未产出 PR，AC5 仍未关**。 |
| 2026-08-28（第四次尝试） | — | **未能运行**，凭据不足，非代码问题。三项前置同时缺失（实测见下）：① 环境无 `omp` 可执行文件；② `OPENCODE_API_KEY` / `DEEPSEEK_API_KEY` 均未设置；③ `gh` 是 Cloud Agent 的 `ghs_` token，建 PR 实测 403（`Resource not accessible by integration`）。**未跑验收、未建 Issue、未伪造结果**。同日合入一项提高成功率的确定性改动（见下方「第三次超时的归因」）。 |
| 2026-08-28（第五次，凭据齐备） | `pnpm vitest run --config vitest.acceptance.config.ts src/acceptance/issue-e2e.acceptance.test.ts` | 用例判绿，**但 T-024 是假绿**（第六次查明后回溯认定）。路径完整走到 `T-024`，PR https://github.com/jionpz/keel/pull/40，~140s。证据：PR 15:32:27 建成、15:32:28 就被 cleanup 关掉 —— 中间只隔 1s，真实 Actions 不可能跑完。环境：fine-grained PAT（`ghp_`）+ `OPENCODE_API_KEY` + omp 18.0.9。本次的确定性收获仍有效：`gh()` 注入 `KEEL_GITHUB_TOKEN` 为 `GH_TOKEN`（`ghs_` 不能打 label，第四次曾因 Issue 无 `keel` label 秒败）。收尾：Issue/PR/分支已清理。 |
| 2026-08-28（第六次） | 同上 | 用例判绿，**查明是假绿并修掉**。路径 `T-001 → … → T-021 → T-024`，PR https://github.com/jionpz/keel/pull/43，263s。核对远端时间线发现：PR **15:45:53** 建成 → T-024 **15:45:56**（3.4s 后），而真实 check-run **15:46:01** 才 `started_at`、15:47:00 / 15:47:09 才 completed —— **CI 还没开始跑，系统已宣布通过**。归因与修复见下方「T-024 假绿的归因」。按诚实纪律：本次不计 AC5 通过。 |
| 2026-08-28（第七次，修复后复跑） | 同上 | **AC5 真通过**。路径 `T-001 → T-002 → T-004 → T-011 → T-012 → T-017 → T-018 → T-021 → T-024`。PR https://github.com/jionpz/keel/pull/45，263s。时间线经远端核对：PR 15:56:16 → 真实 check 15:56:24/26 启动、15:57:21/29 completed=success → T-024 **15:57:32**（末条 check 完成后 3.4s）。即 Keel 真等了 76s 的 CI 才流转。收尾：Issue #44 已关、PR 已关、`ai/*` 分支已删。 |

#### 第三次超时的归因（2026-08-28 代码审阅，尚未经真实运行验证）

把墙钟从 180s 抬到 600s 之后，rfc_draft 反而由「2 次超时 + 第 3 次成功」退化为
「3 次全超时 → T-031」。若只是模型慢，加时间不该让结果更差 —— 说明是**多花掉了轮次**。

机制上有一条对得上的路径：`pipeline.ts` 的 watchdog 是 **整个 session 一个**
（`wallClockMs` 覆盖全部 R-007 轮次），而 `limits.wall_clock_s` 是**每轮**传给 harness 的
（`omp.ts` 的 `--max-time`）。两者被赋了同一个数：第 1 轮就可以合法地用掉全部 600s。
4b 落地后，模型自报 high 的第一轮**必然被拒**并重来 —— 这一轮白烧的时间直接从
session 总预算里扣，于是 4b 把「答得快但答错」换成了「超时」。

已做的修正（commit `9a26b16`，分支 `cursor/ac5-real-e2e-090a`）：4b 核对的是字面值，
提示词却只说「原样采用」，要模型自己从正文认出约束键名。现改为把 4b 将要核对的取值
**原样写进 rfc_draft 提示词**（取自同一个 `parseDeclaredPolicyFacts`，提示词与核对同源），
消掉这一轮可预料的拒绝。不放宽 Policy、不改墙钟语义；未声明约束时逐字等价于改动前。

**已验证**（2026-08-28 第五 / 六 / 七次真实跑）：提示词/4b 同源改动（`9a26b16`）有效，
rfc_draft 一轮过，不再出现 T-030 自环。

**遗留待议**：上述「每轮 `--max-time` = 全 session 墙钟」的不对称本身仍在。
它使 Keel 会在 harness 自认还有余量时把它打断，也让「run 级墙钟」在多轮时含义模糊。
改动涉及 R-009 语义（方案 B / issue #26），按 README「放宽约束走 ADR」的纪律，
**不在本轮擅自更改**，留作后续 ADR 议题。

#### T-024 假绿的归因与修复（2026-08-28 第六次，已修复并经第七次真实验证）

第五、六次的用例都判绿，路径也确实终于 T-024，但 **T-024 不是真实 CI 结论**。
第六次核对远端时间线才看出来：PR 15:45:53 建成 → T-024 15:45:56（3.4s 后），
而真实 check-run 15:46:01 才 `started_at`。CI 尚未开跑，系统已宣布它通过。

机制（`src/fact/github-provider.ts` 的 `combinedStatus`）：

- Actions-only 仓库的 `commits/{sha}/status` **恒为** `state=pending` + 空 `statuses`
  （没有任何 Commit Status 上报方）；
- check-run 要过几秒才注册到 `commits/{sha}/check-runs`（实测 3–10s）。

于是建 PR 后的头几秒，两个端点都读不到任何东西 —— 这个形态与
**「该仓库压根没配 CI」在数据上完全同形**。旧实现有两条通往 `passed` 的出口
（`state=pending` 且零 statuses → passed；无 check 无 status → passed），
本意都是「没配 CI 的仓库不该永远卡死」，却无法与「CI 还没注册」区分，
所以第一次轮询就早退成 passed。

修复（commit `7d71bd2`）：

1. `combinedStatus` 三态改**四态**，新增 `unreported` —— 只如实分辨「无人上报」，
   本身不下结论（CI 是外部事实源，归并函数不制造结论）；
2. `waitForCi` 加**静默期**（`emptySettleMs`，默认 90s，盖住 Actions 排队延迟）：
   读到 `unreported` 必须熬过静默期才认定「该仓库没有 CI」返回 passed，否则继续轮询。
   没配 CI 的仓库依旧不会卡到 30min 硬超时；
3. `issue-e2e` 补 **AC5-3b**：回到 GitHub 核对 head SHA 上真有跑完且成功的 check，
   T-024 不再只靠 Keel 自己的事件作证（防同类假绿复发）。

反例已验证：把 `combinedStatus` 最后一行恢复成旧的 `ok('passed')`，两条新用例确实变红
（轮询次数 1 —— 第一次就早退），恢复修复后转绿。遵循
`spec/backend/error-handling.md` §防假绿「未经反例验证的检查等同于没有检查」。

这一条与本任务此前的教训同源：**T-031 与 Policy 人工闸门同终态**曾让基础设施故障
判成 AC6；这次是**「无人上报」与「CI 通过」同数据形态**让排队延迟判成 CI 通过。
两次都是「两种语义共用一个可观测形态」，都得靠加一维事实（而不是加一个假设）来分开。

## Out of Scope

- Webhook / HTTP 服务接入（推迟到 Phase 3 之后按需评估）
- 守护进程轮询、work queue、并发调度（Phase 3 立项，本轮不实现）
- 多 repo 路由 / 多租户（roadmap §2.1 non-goal）
- 自动合并 PR（roadmap §2.1 明确长期保留人工闸门）
- Issue 评论回灌（澄清问答走 GitHub 评论）、向 Issue 回帖 PR 链接
- GitLab provider
- 修改 Policy 规则集放宽高风险自动路径
