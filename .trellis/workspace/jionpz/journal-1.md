# Journal - jionpz (Part 1)

> AI development session journal
> Started: 2026-08-22

---

## 2026-08-24 · Round 1 组件专家审查修复(#1-01..#1-14)

任务:`.trellis/tasks/08-24-round1-fixes/`(GitHub issue #21,Base 7b27e03)。

14 项全部落地,11 个 commit,`pnpm run check` 全绿(198 tests)。

- #1-01 `rfc_draft` 提示词去写死 policy_facts → Policy 重新成为决策者
- #1-02 capability_request 真正接线(validate 第 4 步求值 + T-009 guard 现场求值 + capability fact 注入),缺裁决一律拒收
- #1-03 RunResult.status→ErrorKind 表映射(CANCELLED 不再被打成 retryable PROTOCOL_ERROR)
- #1-04 executeRun 用 pending.attempt + deps.now()(幂等键与 createRun 同构)
- #1-05 OmpAdapter.interrupt 持有并 kill 子进程(不再只标 aborted)
- #1-06 Human collectChanges 读真实 git(与 OMP 抽共享 git-diff.ts)
- #1-07 TIER_REQUIREMENTS 对齐 tierOf/ADR-0005(STRUCTURED_OUTPUT 移出阶梯)
- #1-08 T-013 guardText/文档对齐守卫(decision != auto_develop,不收窄)
- #1-09 删未接线判定点规则(P-DRIFT/P5;P1/P3 收窄到 rfc_ready),不假装接线
- #1-10 补 git-provider.md/ci-gateway.md 契约;Proposal.kind→ProposalKind
- #1-11 验收 cleanup 从 KEEL_TEST_REMOTE_REPO 解析(ownerRepo 导出复用)
- #1-12 I5 反例补 SELECT artifact/event + EXECUTE keel_commit_artifact
- #1-13 fact 层与 domain-model 对账(rfc_draft/cost_basis/control_mode/stage_outcome/blob/权限矩阵)
- #1-14 C4 比 guardText;purity 空生产文件必败;SessionManager 文档降级;DDL 补 CHECK

经验沉淀:
- 「未接线判定点删规则不假装接线」→ ruleset.ts 注释 + policy-engine.md §2.2
- 防假绿第二层(skip 后空生产文件必败)→ error-handling.md + check-purity.ts
- C4 双向比对扩到 guardText → 防 T-013 类 guardText 分叉复发

遗留:真实 GitHub 验收(test:acceptance)需 KEEL_GITHUB_TOKEN + KEEL_TEST_REMOTE_REPO,
本轮环境未设,cleanup 逻辑已被 ownerRepo 单测覆盖。


## 2026-08-25 · Round 2 P1 修复(issue #23 R1+R2)

任务:`.trellis/tasks/archive/2026-08/08-25-round2-p1`(已归档)。

- R1 run 失败面:executeRun 失败不再 return err 中止 → failRunAndAdvance
  标 run FAILED/TIMEOUT/CANCELLED + emit RunFailed/RunTimeout →
  T-030(重试,key /n 递增)/T-031(升人工);CANCELLED 不重试(R-010)。
- R2 occurred_at 统一:effects emit + pipeline 注入注入 now,requireNow 缺失抛错。

验证:pnpm run check 211 tests 全绿;issue #23 关闭。

## 2026-08-25 · Round 2 P2 行为正确性组(issue #23)

任务:`.trellis/tasks/archive/2026-08/08-25-round2-p2-behavior`。

- R8 git-diff 分类按工作区列(porcelain XY,Y 为主;AD/MM/?? 正确)
- R9 FAILED→PROTOCOL_ERROR 取舍注释真相化(不新增 ErrorKind)
- R7 interrupt 进程组 SIGTERM + 兜底 SIGKILL(spawn detached)
- R5 critic 活锁上限(≥2 强制收敛)
- R3 capability 来自 details.capability(deny 真正可达)
- R4 guard 拒=停(NoTransition 留痕,不假装成功)

验证:pnpm run check 215 tests 全绿。

## 2026-08-25 · Round 2 P2 架构一致性组(issue #23)

任务:`.trellis/tasks/archive/2026-08/08-25-round2-p2-arch`(已归档)。

- R10 tierOf 以 TIER_REQUIREMENTS 为唯一数据源(消除双事实源)+ 最小性断言
- R6 loadPolicyFacts 删未接线分支 post_develop/qa_failed/pre_pr;FACTS_AT
  只列已接线点;validate 对引用未接线点规则报错(强化 #1-09)
- R11 DDL 漂移补 run.stage ↔ STAGES、run.harness_tier ↔ HARNESS_TIERS
- R12 check:generated 生成前先查手改(不再静默覆盖),脚本化
- R13 blob 边界文档真相化(进程存储不经 DB 授权)
- S1 human_review→T-013;S2 ROLES 注释;S3 purity 双清单纪律;S4 blob 措辞

验证:pnpm run check 219 tests 全绿。Round 2(issue #23)全清。

## 2026-08-25 · durable timer(方案 A,issue #24)

任务:`.trellis/tasks/archive/2026-08/08-25-durable-timer-workqueue`。

- T1 timer 表(I9 CHECK、部分唯一索引、GRANT keel_control arw)+ 常量(澄清 24h)
- T2 StartTimer/CancelTimer/ConsumeTimer 真实落库(T-005/T-007/T-008)
- T3 claimDueTimers(SKIP LOCKED,只锁不标)+ loop S-NEED_CLARIFICATION 空闲收割
- T4 e2e:澄清 TTL 全链路 + 取消 + 幂等
- T5 文档(I9/权限/默认值)

用户收敛规划为方案 A:不造 wall_clock Task 事件、不打断 in-flight run、
不做并发池。验证:pnpm run check 228 tests 全绿。

## 2026-08-25 · 完整编排器合并验收(真实 OMP + 真实 GitHub)

任务:`.trellis/tasks/archive/2026-08/08-25-merge-acceptance`(已归档)。

- 凭据:gh token 内联(不进文件);Actions 启用、ci.yml 触发 ** 分支。
- 真实验收暴露并修复:**brainstorm 方案未物化为 A-State → 下游 rfc_draft
  无方案 → 3 次不合格 T-031**。修复 synthesizeStateFromBrainstorm。
- 验收 4 轮跑通到合法终态(S-HUMAN_REVIEW ×2 + S-NEED_CLARIFICATION +
  S-HUMAN_REVIEW);Policy 对模型如实填 facts 裁决 human 是正当行为。
- 残留发现:rfc_draft 模型倾向写项目级 RFC(keel 整体)而非 feedback 方案
  —— context state section 内容/workspace 干扰待查,不阻塞编排器验收。
- 远程零残留(0 PR / 0 ai/* 分支);S-DONE 段由 github-pr.acceptance +
  ci-wiring 各自覆盖。

## 2026-08-26 · rfc_draft 上下文质量(issue #25)

任务:`.trellis/tasks/archive/2026-08/08-26-rfc-context-quality`(已归档)。

- R1:promptFor('rfc_draft') 明确方案来源=用户反馈+A-State 候选,
  「不要给整个项目写」+ 如实评估不硬凑 low。生效:模型产出 feedback
  对应 RFC(「导出 Excel 支持按日期筛选」)而非项目级。
- R3:builder.test 确定性钉住 rfc_draft context 含 feedback+A-State。
- 波动性结论:模型对同一 feedback 判定(actionable/unclear/风险)有波动,
  验收因此停在不同状态 —— 这不是 Keel 缺陷;编排器机制验证达成,
  模型调度波动是 acceptance 的本质(README 已承认)。
- 确定性:low/low/1/false facts → auto_develop(engine 纯函数)。

## 2026-08-26 · durable timer 方案 B:in-flight 会话收割(issue #26)

任务:`.trellis/tasks/archive/2026-08/08-26-timer-planb-infight`(已归档)。

- B1 InterruptReason 加 timeout;OMP 按 reason 分流 TIMEOUT/CANCELLED
- B2 pipeline wallClockMs watchdog(fire-and-forget interrupt)
- B3 executeRun 产/消费 run 级 wall_clock timer(+migration 索引,成功/失败都取消)
- B4 e2e:挂起 run1→TIMEOUT→T-030 重试 run2 成功;生命周期;幂等
- B5 文档

验证:235 tests 全绿。Keel 侧强制收割 run 超时(不再只靠 harness --max-time)。

## 2026-08-26 · 独立 timer worker 进程(issue #26)

任务:`.trellis/tasks/archive/2026-08/08-26-timer-worker-process`(已归档)。

- W1 reapTimeoutRun(RUNNING guard 标 TIMEOUT + cancel timer + RunTimeout→T-030)
  + drainAllDueTimers(澄清 claim→T-008 + run 墙钟 reap)
- W2 e2e 4 例(崩溃恢复/澄清/幂等/终态仅取消)
- W3 脚本示例 + §6 文档

方案 B 局限(进程崩溃收割)解债:到期收割由独立进程承载,不依赖 loop。
验证:243 tests 全绿。

## 2026-08-26 · ADR-0003 正式查证(转 Accepted)

任务:`.trellis/tasks/archive/2026-08/08-26-adr0003-verification`(已归档)。

- H1 转移纯度:三层强制(dep-cruiser error + check-purity 8 类 + 纯函数签名)成立
- H2 可重放:I1/时间注入/getAsOf seq/Facts-Only 四要件齐
- H3 Temporal 官方:确定性约束与 Keel 同构;dev server 单二进制;迁移=换承载
- H4 Inngest:自托管成熟(单二进制本地驻留),官方不保证支持
- H5 SKIP LOCKED:官方语法确认,实现符合短事务姿势

ADR-0003 Proposed → Accepted(自研决策维持,迁移路径确证)。

## 2026-08-26 · CLI 入口(issue #27)

任务:`.trellis/tasks/archive/2026-08/08-26-cli-entry`(已归档)。

- src/cli/:argv 解析(零依赖)、index(bin)、timer-worker/run-task/status
- package.json bin keel;删 scripts/timer-worker.ts(并入)
- 241/248 tests 全绿;build 产 dist;实测 status/timer-worker 命令通过

v0.1 可用命令行入口:收割/驱动任务/状态查询。


## Session 1: rfc-low-risk-ac5: 反馈显式约束机械核对，AC1/AC2 达成

**Date**: 2026-08-27
**Task**: rfc-low-risk-ac5: 反馈显式约束机械核对，AC1/AC2 达成
**Branch**: `main`

### Summary

新增 feedback-constraints.ts 机械核对反馈显式声明与 RFC policy_facts(4b)，冲突回灌 R-007；提示词改「反馈约束原样采用+只允许四键」；run-issue/run-task 透传 wallClockS；pnpm run check 全绿(303 passed)。AC3 真实 e2e 未跑(opt-in)。

### Main Changes

- feat(proposal): 4b 范围一致性机械核对 + spec
- feat(cli): wallClockS 透传

### Git Commits

| Hash | Message |
|------|---------|
| `0c84a40` | (see git log) |
| `6954c52` | (see git log) |
| `c759eb5` | (see git log) |

### Testing

- [OK] pnpm run check: 28 files / 303 passed + 4 skipped

### Status

[OK] **Completed**

### Next Steps

- AC3: keel run-issue --ci real(需 KEEL_GITHUB_TOKEN, 创建真实 PR)


## Session 2: merge-crosscut-fixes 收尾(PR #35)

**Date**: 2026-08-27
**Branch**: `cursor/merge-crosscut-fixes-365e`

### Summary

三份审查的明确缺陷分三批落地(`ee726c3` O2/ADR-0003 交叉补齐、`9ce98a3` 失败/超时 run 成本入账 + 同事务熔断、`68ce401` 删除重叠的 merge.acceptance)。复验 `pnpm run check` 全绿(326 passed / 4 skipped),CI 对三个 commit 均 success,PR #35 已转 ready for review。
刻意 deferred:`ContextBuilt` / `artifact-store.commit` 的 occurred_at(需扩契约)、`ensureTraceId` 无 now 的回落分支、归档快照里 merge.acceptance 的历史引用。

### Status

[OK] **Completed** —— 待 human merge(收尾代理不合并)


## Session 3: finish-work: merge-crosscut-fixes 归档收尾(PR #35)

**Date**: 2026-08-28
**Task**: finish-work: merge-crosscut-fixes 归档收尾(PR #35)
**Branch**: `cursor/merge-crosscut-fixes-365e`

### Summary

代理代为执行 finish-work 全流程：修正 .trellis/.developer 被写成 --help 导致 active 任务不可见的问题；archive 08-27-merge-crosscut-fixes 到 archive/2026-08/；记录本 session；随后 squash merge PR #35 到 main。merge 排在 archive/journal 之后，使代码与归档在 main 上同一 commit 落地。

### Main Changes

- chore(task): archive 08-27-merge-crosscut-fixes -> .trellis/tasks/archive/2026-08/
- 修正 .trellis/.developer(name=--help -> jionpz)，恢复 record 模式的 active 任务视图

### Git Commits

| Hash | Message |
|------|---------|
| `ee726c3` | (see git log) |
| `9ce98a3` | (see git log) |
| `68ce401` | (see git log) |
| `b38b5ef` | (see git log) |
| `c7cc4c0` | (see git log) |

### Testing

- [OK] 工作树 clean，Step 2 无 dirty 路径需分类
- [OK] CI 对 .trellis/ 单独变更历史上均 success(c7cc4c0 / b38b5ef)

### Status

[OK] **Completed**

### Next Steps

- R4 契约级遗留：ContextBuilt / artifact-store.commit 的 occurred_at 需扩事件契约，独立任务
- ensureTraceId 省略 occurredAt 的回落分支待全部调用点改注入时钟后清零


## Session 4: Claude Code 第二 Harness：接入并收尾

**Date**: 2026-08-29
**Task**: Claude Code 第二 Harness：接入并收尾
**Branch**: `feat/second-harness`

### Summary

实现 ClaudeCodeAdapter，经 --harness / KEEL_HARNESS 切换（缺省仍 omp）。untrusted 强制 --bare。pnpm run check 全绿。未跑 claude-code-e2e（无 ANTHROPIC_API_KEY），不宣称 Harness 可替换已验证。

### Main Changes

- ClaudeCodeAdapter + stream-json 解析 + CLI resolveHarness
- 缺 claude 二进制或缺 ANTHROPIC_API_KEY 在 ingest 前失败，避免 T-031 假绿

### Git Commits

| Hash | Message |
|------|---------|
| `2867719` | (see git log) |

### Testing

- [OK] pnpm run check：404 passed / 5 skipped
- [OK] claude-code-e2e 未跑（无 ANTHROPIC_API_KEY；--bare 不读 OAuth）

### Status

[OK] **Completed**

### Next Steps

- 补 ANTHROPIC_API_KEY 后跑 claude-code-e2e，再决定是否把「可替换」标为已验证
- 父任务 08-29-phase2-entry 仍开放（wallclock-adr / ingress-poller 按需）

## Session 5: 收口 collectChanges + 修 firstRun 撞键 + --wall-clock

**Date**: 2026-10-26
**Tasks**: `10-25-collect-changes-wiring`（归档）、`10-26-run-reentry-wallclock`（归档）
**Branch**: `main`

### Summary

两条任务一起收口。`collectChanges` 接进编排后，真机 claude 跑通到 S-DONE（5 run ≈$0.13），
develop 的 diff 事件与 commitAll 的 commit 对得上。随后修掉 `firstRun` 漏改这一类缺陷：
`T-010`/`T-012`/`T-017`/`T-018` 四处落在可二次进入的位置，返工后重进阶段会算出重键 →
只有 `SideEffectSkipped` → 驱动无 pending run 直接收工，Task 静默停在原状态。
同时给 `run-task` / `run-issue` 补上 `--wall-clock`。

### Main Changes

- 四处 `firstRun` → `nextRun`，每处注释点明二次进入路径
- `ALLOWED_FIRST_RUN` 白名单 + **双向**断言（多/少都红），断言对象是转移 id 不是阶段名
- `SideEffectSkipped` 的 CreateRun payload 加 `existing_status`：PENDING = 真重放，终态 = 派发丢失
- `parseWallClock` + 两个 CLI 入口 + 顶层 HELP；非法值退出码 1，不静默回退 180
- spec 新增 `transition-effects.md`；database-guidelines 补 `asRole` 只在抛错时回滚

### Git Commits

| Hash | Message |
|------|---------|
| `39d93ae` | feat(control): 接上 collectChanges —— develop 后收真实 diff 并喂给 QA/Review |
| `2ca98b3` | fix(control): firstRun 漏改四处 —— 返工后重进 qa/review/rfc_draft/develop 会撞幂等键卡死 |

### Testing

- [OK] `pnpm run check`：35 files / 449 passed, 5 skipped
- [OK] 四组负对照都真的变红（T-017 改回 first / 去 existing_status / 放宽墙钟守卫 / 删 wallClockS 展开），还原后转绿
- [OK] CLI 端到端 `--wall-clock 0|abc|1.5` 退出码 1；`--wall-clock 600` 过闸进 runTask

### Status

[OK] **Completed**

### Next Steps

- driver「无 PENDING run 即收工、退出码 0」是另一条缺陷，单独立项
- R4 契约级遗留：ContextBuilt / artifact-store.commit 的 occurred_at 需扩事件契约
- 未决：`.trellis/.template-hashes.json` 与未跟踪的 `.agents/` `.codex/` `.dsh/` 是否入库

## Session 6: 停止原因可区分 —— 静默收工改成可诊断的报错

**Tasks:** `.trellis/tasks/archive/2026-10/10-26-orchestrator-stop-reasons`

### Summary

`loop.ts` 的「阶段态没有 PENDING run → `return ok`」把设计内等待、派发丢失、进程已死
三件事压成同一个成功返回。上一轮刚被它坑过：firstRun 撞键导致 T-017 派发丢失，任务
静默停在 S-QA，看起来像「QA 自己跑完了」，查了两轮才找到上游。

### Main Changes

- 判据读证据不按状态归类：阶段态 + 无 PENDING run 时看**最近一次 run** ——
  `CANCELLED` 是设计内的停（`ok` + `cancelled`），其余是故障（`err(NOT_FOUND)`）
- 错误 detail 三要素：当前状态 / 最近 run 的 stage·attempt·status（无 run 明说）/
  下一步查 `SideEffectSkipped.existing_status`（PENDING·RUNNING = 真重放，终态 = 派发丢失）
- `RunToCompletionResult.stopReason` **必填**（7 值），六处既有 `ok` 各补原因 ——
  必填是「新增停止路径忘了表态就编译不过」的强制点
- CLI `printRunResult` 多打 `stopped: <reason>（人话）`；`finalStatus:` 行不动
- 只报告不修复：不自动重派 / 不改 control_mode / 不回滚
- spec 新增 `backend/orchestrator-loop.md`；顺带修掉 `effects.ts` 注释里并不存在的 `CLAIMED`

### Git Commits

| Hash | Message |
|------|---------|
| `be15408` | fix(control): 停止必须带原因 —— 阶段态无 PENDING run 不再当「跑完了」 |

### Testing

- [OK] `pnpm run check`：36 files / 460 passed, 5 skipped
- [OK] 负对照 N1：「一律 ok」→ AC1 / AC6 / AC1' 红 3 绿 6；N2 还原 → 9 全绿

### Status

[OK] **Completed**

### Next Steps

- 多 worker 出现时，「RUNNING 在别人手里」与「RUNNING 死在崩溃进程里」要用租约区分
  —— 现在的 RUNNING 判据只在单进程前提下成立（已写进 spec）
- 剩余遗留不变：GitHub-Issue + 真 CI 验收线未验；R4 `occurred_at` 契约；`post_develop` 策略点未接线
- 未决：`.trellis/.template-hashes.json` 与未跟踪的 `.agents/` `.codex/` `.dsh/` 是否入库


## Session 5: 只读控制台 + demo APP 真实闭环

**Date**: 2026-10-27
**Task**: 只读控制台 + demo APP 真实闭环
**Branch**: `main`

### Summary

新增只读 Web 控制台（src/cli/console*.ts，pnpm run console，127.0.0.1:4321），补 README 本地部署与控制台用法，记录前端/数据库规范。修复 keel_dev 缺失迁移 0003/0004（keel_ingress 无 schema USAGE 时表现为 relation does not exist）。新建 jionpz/keel-demo-app，用真实 Issue #1 驱动 run-issue --ci real --harness claude，走完 S-NEW→S-DONE，产出真实 PR #2 并合并，CI 全绿；pnpm run check 全绿。

### Git Commits

| Hash | Message |
|------|---------|
| `e8c7718` | (see git log) |
| `9045785` | (see git log) |
| `1af85b1` | (see git log) |

### Status

[OK] **Completed**


## Session 6: Console 双模式筛选

**Date**: 2026-11-03
**Task**: Console 双模式筛选
**Branch**: `main`

### Summary

console 完成可读性/项目性改造：中文状态徽章、一句话现状、轨迹停留时长条、术语表、任务/项目双视图、布局收敛，以及本轮筛选（任务模式项目下拉+状态 chip，项目模式按状态筛当前项目任务表，chip 计数跟随筛选口径）。全部经无头 Chrome 验证，lint/typecheck/542 测试通过。

### Git Commits

| Hash | Message |
|------|---------|
| `7efdba8` | (see git log) |
| `56953e5` | (see git log) |
| `55d06bc` | (see git log) |
| `38d836d` | (see git log) |
| `bab2646` | (see git log) |

### Status

[OK] **Completed**


## Session 7: GHES host 支持收尾：契约测试与 spec 落地

**Date**: 2026-11-04
**Task**: GHES host 支持收尾：契约测试与 spec 落地
**Branch**: `main`

### Summary

复核 77f7008 后补齐 github-provider 契约测试（42→55 用例：host 白名单、URL 归一/拒绝、API root 三级优先级与空白非 http(s) fail-closed），新增 backend/github-provider.md 并接入 spec 索引与环境变量矩阵；prd/implement 勾选验收并如实记录未覆盖项（无 GHES 实例、preflight.ts 仍硬编码 github.com、http remote 跨层比对限制），任务已归档。

### Git Commits

| Hash | Message |
|------|---------|
| `2d61e53` | (see git log) |
| `aea6768` | (see git log) |

### Status

[OK] **Completed**


## Session 8: git 传输认证：私有 https remote 注入凭据

**Date**: 2026-11-04
**Task**: git 传输认证：私有 https remote 注入凭据
**Branch**: `main`

### Summary

新增 github-auth.ts（token 读取/authEnvFor/gitAuthSecrets/redactSecrets）与 github-remote.ts（host 解析下沉，避免循环依赖），clone/fetch/push 改用 GIT_CONFIG_* 单次子进程注入，token 不进 argv/错误 detail；复核发现非默认端口下 extraheader 不匹配的真实缺口并修复（authority 取 URL.host），补齐脱敏与合并断言（github-auth 15、git-workspace 33），pnpm run check 全绿；spec 记录契约与已知边界，任务已归档。

### Git Commits

| Hash | Message |
|------|---------|
| `48b0dff` | (see git log) |
| `f2c634f` | (see git log) |

### Status

[OK] **Completed**


## Session 9: 接入自动化 poller：多仓库 issue 常驻扫描

**Date**: 2026-11-04
**Task**: 接入自动化 poller：多仓库 issue 常驻扫描
**Branch**: `main`

### Summary

实现 keel poller：迁移 repo.issue_label + register-repo --issue-label、provider listOpenIssues（分页/truncated/PR 过滤/空 label 拒绝）、src/ingress 轮询核心（轮内去重、单条失败隔离）、CLI 接线与 finally 关池；复核修掉 5 个真缺陷（StopToken 订阅制替代悬挂回调、重复 remote 轮内去重、argv 空白语义漂移、--label 静默忽略、日志里 remote userinfo 泄漏），pnpm run check 629 passed；spec 记录契约与已知边界，任务已归档。跨任务遗留：其它 CLI 子命令退出不关池、timer-worker SIGTERM 忙等。

### Git Commits

| Hash | Message |
|------|---------|
| `3c9e604` | (see git log) |
| `8472c5f` | (see git log) |

### Status

[OK] **Completed**


## Session 10: 人工闸门入口：keel decide / keel answer 与控制台可复制命令

**Date**: 2026-11-04
**Task**: 人工闸门入口：keel decide / keel answer 与控制台可复制命令
**Branch**: `main`

### Summary

状态机里 T-014/T-015/T-016/T-007 一直有定义但没有任何代码发事件，任务停在 S-HUMAN_REVIEW 无限期卡住。新增 src/cli/decide.ts（keel decide approve|reject|rework --note、keel answer --text），三条纪律：预检(status+control_mode)在写入之前、control_mode≠auto 如实拒绝、approve 注入真实 workspace（抽出共用的 task-workspace.ts）。LinkFeedback 在事件带 feedbackId 时真写 task_feedback，否则维持记录意图；answer 因 feedback 只能由 keel_ingress 写而是两段写，失败时把孤立 feedback id 报出来。advance 新增第 4 参 { note }，同事务补 HumanDecision 事件。控制台新增只读 .human-callout，只给可复制命令、不加写端点。全量 pnpm run check 48 文件 652 通过。

### Git Commits

| Hash | Message |
|------|---------|
| `23cb377` | (see git log) |

### Status

[OK] **Completed**


## Session 11: 人工闸门决策页

**Date**: 2026-11-04
**Task**: 人工闸门决策页
**Branch**: `main`

### Summary

控制台从「一排批准按钮」改成决策页：闸门状态默认落 decision Tab，四块为为什么停在这里（PM 理由 / T-031 升级原因）/ 证据（触发 Run + 同阶段 attempt 轨迹）/ 这次决定依赖的事实（分支、RFC、diff、预算）/ 选项（写清副作用，理由内联 textarea，必填为空禁用，去掉 window.prompt）。澄清闸门对称：在问什么、TTL 剩余 → S-ABANDONED。写入口仍是转调 decide.ts 的两个端点；选项 key 与 DECISIONS 由 console.test.ts 锁死。pnpm run check 48 文件 664 通过。

### Git Commits

| Hash | Message |
|------|---------|
| `a2e4a6d` | (see git log) |
| `c1837b8` | (see git log) |

### Status

[OK] **Completed**


## Session 12: 项目页按「少思考」重构

**Date**: 2026-11-04
**Task**: 控制台项目页按「少思考」重构信息架构
**Branch**: `main`

### Summary

项目页原先是仪表盘：6 块指标带、状态分布条、6 列表格，侧栏一项 4 行还带完整 URL。重构成先回答「有没有事等我」：侧栏 2 行（短名 + 待处理徽章 / 任务数 · 非零状态 · 最近更新），按 needsYou 降序排；详情头部一句话现状 + 一行累计元信息，删掉指标带与分布图；任务按 需要你处理 → 进行中 → 等待中 → 已收尾 分组，首组行内给「去决策 / 去回答 →」，点击仍走 select()。needsYou 只数 isGateStatus，避免把系统等待误报成人的待办。状态 chip 移到列表上方（.proj-filters），侧栏只留项目搜索。改动的取舍、分组契约与验证清单落在 .trellis/tasks/11-04-console-project-page-simplify/。pnpm run check 48 文件 664 通过。

### Git Commits

| Hash | Message |
|------|---------|
| `bb6a496` | (see git log) |

### Status

[OK] **Completed**


## Session 13: 控制台视觉重做：海图仪表

**Date**: 2026-11-04
**Task**: 控制台视觉重做：海图仪表
**Branch**: `main`

### Summary

页面「像 AI 做的」不是配色问题，是默认值问题：macOS 系统色、填充胶囊徽章、`·` 拼接元信息、`→` CTA、脉冲圆点、一个蓝色表示所有状态。换的主张只有一句——墨色表示位置，颜色表示要不要你动手：位置（第几段、多久）全用墨色深浅与刻度；颜色只回答「需不需要人」，四个语义色各对应一种行动（琥珀=需要你、海蓝=进行中、苔绿=已收尾、铁锈=异常），且只以 2px 线 / 7px 方块两种形态出现。字体换成 Avenir Next + PingFang SC，等宽只留给 ID / 分支 / 命令 / JSON / diff / 事件码（数字一律 tabular-nums，否则整页退回终端截图气质）。状态机轨迹从 10 个等重卡片改成一把刻度尺：每段一条 2px 基线，填充比例是停留时长，当前段压墨线当游标，偏离主路径时游标压在分出站并转琥珀。决策页三个选项改成三条竖直色带（顶线颜色说明后果）。文案层同步去机器腔：`estimated`→估算、`SUCCEEDED`→成功、`A · B`→`A，B`，但证据区（payload、错误类型、转移编号）保留原文。顺带修了 ≤900px 时状态栏插在侧栏与详情中间的旧 bug（`.statusbar` 基础样式写死 `grid-row: 2`，窄屏必须显式重排三块）。验证：1440 明/暗、1024、900、决策/概览/项目/事件/执行四个 Tab 逐屏截图，`pnpm run check` 48 文件 665 通过。

### Lessons

- **JS 的 `String.prototype.replace(a, b)` 会把 `b` 里的 `$'` / `` $` `` / `$&` 当替换模式**：一次批量改文案时新字符串里有「，预算 $'」，`$'` 展开成「匹配点之后的全部内容」，文件瞬间从 5310 行变 6482 行。批量替换一律写 `s.replace(a, () => b)`，或改用 Python/Perl 的 `str.replace`（没有这个坑）。
- **`overflow-x: auto` 会隐式裁掉纵向溢出**：轨迹游标原本用 `top: -11px` 的 `::before`，被裁得看不见；改成给 `.step` 加 `padding-top`、游标放 `top: 0`。
- **截图的「问题」可能是缩放伪影**：600px 宽的截图里侧栏时间像被裁掉，量了 DOM 才发现右边缘 257 < 容器 265。改用 CDP `clip` + 2× scale 裁切，不要凭缩略图改 CSS。
- **窄屏重排必须显式写 `grid-row`**：基础样式里 `.statusbar { grid-row: 2 }` 在单列布局下会把状态栏插到侧栏和详情之间，只改 `grid-template-rows` 不够。

### Git Commits

| Hash | Message |
|------|---------|
| `08e9c88` | (see git log) |

### Status

[OK] **Completed**


## Session 12: 修复工作区基线与生命周期（P0+P1）

**Date**: 2026-11-04
**Task**: 修复工作区基线与生命周期（P0+P1）
**Branch**: `main`

### Summary

落地 7 项 review 发现：CreateBranch 用 branchCreated 区分分支新建（删除后重建不伪造 base_sha）；CIPassed/CIFailed 必填 source 并落 TaskStatusChanged.payload.source；KEEL_HOME 从 cwd 向上解析、blob 根跟随 KEEL_HOME；T-015/T-024 增加 CleanWorkspace，清理失败写 SideEffectIntent 不回滚终态；ensureWorktree 路径校验 fail closed、陈旧元数据 prune 重试；新增 keel unlock 与 lock_timeout hint；decide reject 仅在已有 worktree 时准备工作区。pnpm run check 全绿（50 files / 700 tests）。

### Git Commits

| Hash | Message |
|------|---------|
| `c0ad554` | (see git log) |

### Status

[OK] **Completed**


## Session 13: 控制台口令登录与会话鉴权

**Date**: 2026-11-04
**Task**: 控制台口令登录与会话鉴权
**Branch**: `feat/console-login-auth`

### Summary

控制台从无鉴权改为强制口令登录：scrypt 哈希 + 常量时间比较、进程内会话与 HttpOnly/SameSite=Strict Cookie、按 IP 5 次/5 分钟与全局 20 次/5 分钟限流；新增与主页面同配色的登录页和顶栏退出入口；/healthz 对匿名只返回 {ok}；KEEL_CONSOLE_HOST 可配置对外但鉴权不降级。pnpm run check 731 通过，浏览器与 0.0.0.0 局域网实测通过。

### Git Commits

| Hash | Message |
|------|---------|
| `909a7af` | (see git log) |

### Status

[OK] **Completed**


## Session 14: 运行巡检落地：卡死判定改为进展信号

**Date**: 2026-11-05
**Task**: 运行巡检落地：卡死判定改为进展信号
**Branch**: `main`

### Summary

实现 run_liveness 遥测、进程内 StallSupervisor 与独立 Patrol；新增 RunStalled 事件并复用 T-030/T-031；成功/失败路径加 run 状态围栏；human 与无 CAP-STREAM 豁免；补 run-liveness spec。全量 check 782 passed、e2e 47 passed，任务已归档。

### Git Commits

| Hash | Message |
|------|---------|
| `9fd5b87` | (see git log) |
| `4c7a26a` | (see git log) |
| `b4705e5` | (see git log) |

### Status

[OK] **Completed**


## Session 15: 执行面模型路由：按阶段对接企业网关

**Date**: 2026-11-05
**Task**: 执行面模型路由：按阶段对接企业网关
**Branch**: `main`

### Summary

新增 model-routing：default/enterprise 阶段表、四级优先级、allowlist 启动期预检；omp RunSpec.model 与 run.requested_model 同源落库；claude 行为不变。迁移 0008 单独提交。pnpm run check 827 passed | 5 skipped；任务已归档。

### Git Commits

| Hash | Message |
|------|---------|
| `edff9e8` | (see git log) |
| `1b4f3e6` | (see git log) |
| `b99de02` | (see git log) |

### Status

[OK] **Completed**


## Session 16: 放宽 auto_develop 放行带

**Date**: 2026-11-05
**Task**: 放宽 auto_develop 放行带
**Branch**: `main`

### Summary

P4 条件改为 risk=low && complexity!=high，中等复杂度低风险不再默认落 human_review；DEFAULT_ACTION / 严格性偏序未动。新增 policy-ruleset spec 记录放行带真值表与修改纪律，规则版本升 2026-11-05，回退反例实测会红。

### Git Commits

| Hash | Message |
|------|---------|
| `7524dbd` | (see git log) |
| `797129c` | (see git log) |
| `2e084de` | (see git log) |

### Status

[OK] **Completed**


## Session 17: S-HUMAN_REVIEW 超时自动收尾

**Date**: 2026-11-05
**Task**: S-HUMAN_REVIEW 超时自动收尾
**Branch**: `main`

### Summary

人工裁决不再无限期挂起：复用澄清 TTL 机制加 human_review_ttl（默认 24h，KEEL_HUMAN_REVIEW_TTL_H 可覆盖或关闭），5 条进入转移武装、3 条离开取消、T-028 收割到期转 S-ABANDONED；claimDueTimers 加 join task 状态过滤并只锁 timer 行；顺带修掉终态残留澄清 timer 的泄漏。全量 check 绿（868 passed / 5 skipped，C4 33 条一致），两处真反例先红后绿。

### Git Commits

| Hash | Message |
|------|---------|
| `37c8b0c` | (see git log) |

### Status

[OK] **Completed**


## Session 18: 收窄 Trellis 工作流的人工确认点

**Date**: 2026-11-05
**Task**: 收窄 Trellis 工作流的人工确认点
**Branch**: `main`

### Summary

去掉「建任务前问一次、task.py start 前再问一次」两次人工批准，改为默认继续、只在三类必停情况下询问（未决取舍且导出不同验收标准 / 超出单任务 / 破坏性或不可逆操作）。保留证据先行、Requirement Convergence Gate、PRD Convergence Pass；用「开工第一句话说明 Goal·In Scope·Exclusions」替代原开工前批准，把纠偏点后移到第一个可见步骤。新增 .trellis/spec/guides/workflow-overrides.md 记录覆盖项、判据锚点与 trellis update 后的三条自检命令。

### Git Commits

| Hash | Message |
|------|---------|
| `3a922c5` | (see git log) |

### Status

[OK] **Completed**


## Session 19: 失败 run 落 harness 身份（#73-1）

**Date**: 2026-11-05
**Task**: 失败 run 落 harness 身份（#73-1）
**Branch**: `main`

### Summary

失败/超时/撤回结算与 harness_id 同事务；身份改为 claim 时即写，覆盖 timer/patrol 外部收割路径

### Main Changes

- claimRunForExecution 在同一条 UPDATE 写 harness_id/harness_tier（拒绝路径不写）
- loop 在 claim 前 describe 一次并传入执行主体；失败结算保留 RUNNING 围栏并兜底写身份
- 新增 limits/reap 用例，patrol 与 run-failure 补外部收割身份断言；spec run-liveness 记录契约

### Git Commits

| Hash | Message |
|------|---------|
| `edee68d` | (see git log) |

### Testing

- [OK] pnpm run check：61 文件，874 passed / 5 skipped
- [OK] 重点用例：limits 9、run-failure 8、patrol 10、reap 1

### Status

[OK] **Completed**

### Next Steps

- 父任务剩余：github-token-source、poller-single-instance（需 design.md）


## Session 20: GitHub token 来源与启动期校验（#73-3）

**Date**: 2026-11-05
**Task**: GitHub token 来源与启动期校验（#73-3）
**Branch**: `main`

### Summary

token 优先级 KEEL > GITHUB > gh(按 host)；三个入口在写入前 fail fast；provider/传输层按 host 解析并脱敏

### Main Changes

- 新增 resolveGitHubToken 单一解析器，空白 env 不遮蔽 gh，gh 失败不抛/不带 stderr
- GitHubProvider 与 GitWorkspace 按 host 缓存 token；gh 来源 token 进入 secrets 脱敏集合
- run-issue / poller / run-task --ci real 启动期预检；新增 loadTaskRemoteUrl 只读助手
- spec github-provider/git-workspace 记录契约；测试全部注入 runGh/tokenResolver

### Git Commits

| Hash | Message |
|------|---------|
| `9889e38` | (see git log) |

### Testing

- [OK] pnpm run check：61 文件，900 passed / 5 skipped
- [OK] 假 gh + 清空 env 跑全量：gh 零调用，证明测试不依赖开发机登录态

### Status

[OK] **Completed**

### Next Steps

- 父任务仅剩 poller-single-instance（需先补 design.md）


## Session 21: 常驻进程单实例锁（#73 第 2 项）

**Date**: 2026-11-05
**Task**: 常驻进程单实例锁（#73 第 2 项）
**Branch**: `main`

### Summary

poller 与 timer-worker 用 PostgreSQL 会话级 advisory lock 强制同库单实例；拿不到锁非 0 退出，崩溃自动释放。

### Main Changes

- 新增 src/fact/resident-lock.ts：专用 pg.Client + pg_try_advisory_lock(classid, objid)，release 幂等，lockErrorMessage 脱敏连接串。
- pollerMain / timerWorkerMain 启动期取锁；poller 在任何 repo 读取前，timer-worker 在创建 LivenessStore 前；单次 timer-worker 也持锁。
- 释放收口在各自 finally：poller 先 release 再关池；timer-worker 先 store.close 再 release。取锁后全部代码纳入 try/finally。
- CLI 测试全部注入 acquireLock；真实锁语义由 resident-lock 真实 Postgres 测试覆盖（含裸 Client 断连模拟 kill -9）。

### Git Commits

| Hash | Message |
|------|---------|
| `1ab1a60` | (see git log) |
| `213815e` | (see git log) |

### Testing

- [OK] pnpm run check 全绿：63 test files，915 passed / 5 skipped（skip 为既有）。
- [OK] 反例验证：锁不释放时 resident-lock 测试变红；objid 固定时双角色共存用例变红。

### Status

[OK] **Completed**

### Next Steps

- 待确认：推送 main 并关闭 GitHub issue #73。


## Session 22: 把 workflow-overrides 自检接进 pnpm run check

**Date**: 2026-11-05
**Task**: 把 workflow-overrides 自检接进 pnpm run check
**Branch**: `main`

### Summary

新增 scripts/check-workflow-overrides.ts 并接入 check 链：校验判据锚点存在、11 个驱动文件无旧 gate 措辞、brainstorm 与 change-workflow 各三份镜像逐字节一致。防假绿与文件缺失均计为失败。四条红例与两条边界均已实测先红后绿，pnpm run check 全绿（915 passed）。

### Git Commits

| Hash | Message |
|------|---------|
| `965ca50` | (see git log) |

### Status

[OK] **Completed**
