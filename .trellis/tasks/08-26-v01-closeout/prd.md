# v0.1 收口：合并验收与父任务关闭

> 父任务：`08-23-v01-closed-loop`
> 范围决策：**A**（2026-08-26）—— 合并验收 + 集成复核 + O4 + Human L0 + 文档同步；**C-002 切出**

## Goal

用**一次真实运行**完成 v0.1 判据的完整证明——一条真实反馈经 `runTaskToCompletion` 无人干预走完 `S-NEW → S-DONE`，产出真实 GitHub PR 且真实 CI 通过，且 `readEvents(task_id, 0)` 完整重建全过程——并据此完成父任务的集成复核与诚实关闭。

## Background

- 9 个子任务均已 completed；父任务仍 `planning`，跨子任务 checklist 全空。
- 判据目前两半拼接：`v01-criterion`（CI 注入）与 `github-pr`（不经编排器）。
- 产品接线已齐：`opts.ci`、`WorkflowDriver.github`、`CreatePullRequest`、`GitHubProvider`（`PullRequestGateway` + `CiGateway`）。
- push 鉴权靠环境 git credential（如 `gh`）；`KEEL_GITHUB_TOKEN` 覆盖 API。

## Requirements

### R1 · 合并验收

新增 `src/acceptance/v01-criterion-github.acceptance.test.ts`（**不改造**现有 `v01-criterion`，保留本地 cheap 回归）：

- seed 使用 `KEEL_TEST_REMOTE_REPO` 克隆裸仓库（先例：`github-pr.acceptance.test.ts`）
- `GitHubProvider` 同时注入 `WorkflowDriver` 第三参与 `opts.ci`；**不用** `externalCi`
- 无人干预走完 `S-NEW → S-DONE`；事件含真实 `SideEffectApplied`（CreatePullRequest）；`T-024` 由真实 `waitForCi='passed'` 驱动
- 缺 `KEEL_GITHUB_TOKEN` / `KEEL_TEST_REMOTE_REPO` 时 beforeEach **明确失败**
- 收尾：关 PR、删远端 `ai/*` 分支
- 保留现有断言：转移序列、`ContextBuilt`、`policy_decision`、develop 分支提交

### R2 · 父任务集成复核

在父任务 `prd.md` 书面回答：

1. `docs/08-cross-cutting.md` §2.2 四问（引用事件 payload）
2. 幂等重放：对已完成 Task 重复触发需幂等的 advance/effect，断言 `SideEffectSkipped`（确定性单测）
3. Human L0 路径结论（由 R4 e2e 证明）

跨子任务 checklist：逐项勾选；**C3（C-002）** 显式标注缺口并链接后续任务 slug `v01-budget-fuse`（仅记录，本任务不建）。

### R3 · O4 时间线导出

`pnpm run timeline -- <task_id>`（tsx 脚本）：stdout 输出该 Task 的完整事件序列（seq、type、payload 摘要），读 `ArtifactStore.readEvents`。

### R4 · Human L0 最小闭环

确定性 e2e：`HumanAdapter` + 同步 `HumanInbox` 桩在编排循环中跑通至少一个阶段（如 PM），断言产物落库且 `produced_by_run` 非空。放在 `src/e2e/`，进 `pnpm run check`。

### R5 · 文档同步

| 位置 | 修正 |
|---|---|
| `docs/01-overview.md` §8 | GitHub 集成已完成 |
| `docs/README.md` 状态表 | GitHub 集成 + ADR-0005 Accepted |
| `src/acceptance/v01-criterion.acceptance.test.ts` 头注释 | 子任务 7 已完成；CI 注入是本地版刻意设计 |
| `src/control/orchestrator/loop.ts` `externalCi` 注释 | 同上 |
| `docs/adr/0004-persistence.md`、`0006-session-recovery.md` | 复核 Status（实现已交付 → Accepted 或写明保持 Proposed 理由） |

### R6 · 收尾

- 归档 `08-23-split-acceptance-tests`（若仍 active）
- 父任务与本任务转 completed 并归档（实现完成后由主会话执行）

## Out of Scope

- `C-002` 预算熔断（后续任务 `v01-budget-fuse`）
- durable timer / work queue
- 连续 5 个真实 Task / CLI 入口
- 第二 Harness、ADR-0003 查证、UI、自动合并 PR

## Acceptance Criteria

- [ ] `v01-criterion-github.acceptance.test.ts` 在凭据齐全时一次跑通 `S-NEW → S-DONE`（真实 PR + CI）
  —— 2026-08-27 实测推进到 `S-REVIEW` + **真实 push 成功**，卡在 PR 创建（环境 token 无
  `pull-requests:write`，HTTP 403 → `AUTH_FAILED`，系统行为符合规范）。
  同一轮抓出并修复了**判据级缺陷**：Agent 从未收到 ContextBuilder 的产出（详见验收记录第二轮 §1）。
  待有 PR 创建权限的 token 重跑最后一步
- [x] 验收记录写入本任务 `prd.md`（实现阶段记录已写；合并验收通过后补 PR 链接）
- [x] 父任务集成复核三问有书面答案；checklist 勾选或显式缺口（C3 → `v01-budget-fuse`）
- [x] 幂等重放确定性单测在 check 中为绿
- [x] `pnpm run timeline -- <task_id>` 输出完整事件序列
- [x] Human L0 e2e 在 check 中为绿
- [x] 文档漂移修复；`pnpm run check` 全绿
- [x] `08-23-split-acceptance-tests` 已归档

## Key Decisions

| 决策 | 选择 | 理由 |
|---|---|---|
| 收口范围 | A | 诚实关父任务且不拖 C-002 新功能 |
| 合并验收落点 | 新文件 | 与 `github-pr` 先例一致；本地版保留 |
| C-002 | 切出 | control_mode 首次实现，牵动转移表 |

## Risks / Deferred

- 合并验收依赖推理网关 + GitHub；LLM 波动可能导致重跑（acceptance 分离已兜底）
- 合并验收耗时长（~3–15 min），不进默认 check

## Notes

- 前置：`gh` 登录 + `KEEL_GITHUB_TOKEN` + `KEEL_TEST_REMOTE_REPO` + OMP
- 子代理禁止 `git commit`；主会话负责提交与 PR

---

## 验收记录

### 2026-08-26 · 实现完成（云环境，Implement 子代理）

- `pnpm run check` **全绿**（lint / typecheck / boundaries / check:generated /
  check:transitions / check:purity / 12 个测试文件，含本次新增的
  `human-harness.test.ts` 与 `effects.test.ts` 幂等重放块）。
- `pnpm run timeline -- <task_id>` 已实测：对 Human L0 e2e 留下的真实 Task 输出
  6 条完整事件（`RunCreated → TaskStatusChanged(T-002) → ContextBuilt →
  ProposalAccepted → RunCreated → TaskStatusChanged(T-004)`）；
  缺参数 / 非 UUID / task 不存在 / 数据库不可用四条失败路径均已反例验证（exit 1 + 可操作信息）。
- **合并验收 `v01-criterion-github.acceptance.test.ts`**：
  - 2026-08-26 云环境二次尝试：已安装 omp v18.0.6；GitHub 凭据与 DB 就绪；测试启动编排器后在 PM 阶段因 **缺少 DeepSeek API key** 失败（omp 报错 `No API key found for deepseek`）——非代码缺陷。
  - **待有 API key 的环境执行**（命令同上）；通过后补 PR 链接。

  ```bash
  KEEL_GITHUB_TOKEN="$(gh auth token)" \
  KEEL_TEST_REMOTE_REPO=https://github.com/jionpz/keel \
  pnpm run test:acceptance src/acceptance/v01-criterion-github.acceptance.test.ts
  ```

  （注意：pnpm 下不要在文件名前加 `--`，否则 vitest 会把过滤器当作 `--` 后的
  透传参数而跑全部验收文件。缺凭据时本文件已实测**明确失败**而非 skip。）

  通过后在此补记：日期 / 走过的路径 / 耗时 / PR 链接。

### 2026-08-27 · Opus 验收子代理：合并验收仍**阻塞**，但顺带修掉一个真实缺陷

**结论：合并验收 = blocked（`DEEPSEEK_API_KEY` 缺失），未通过、也未伪造通过。**

**1）阻塞点（与 08-26 同一处，本次为一手复现）**

- 环境：omp v18.0.6 就绪、`KEEL_GITHUB_TOKEN` 就绪、`KEEL_TEST_REMOTE_REPO=https://github.com/jionpz/keel`
  就绪、Postgres 就绪；**唯独 `DEEPSEEK_API_KEY` 未注入**，且 omp 侧无其它可用 provider
  （`~/.omp/agent/agent.db` 无凭据，env 中除 GitHub token 外无任何 API key）。
- 直接探针：`omp -p --mode=json --model deepseek-v4-flash "say ok"`
  → `error: No API key found for deepseek.`
- 走真实路径复现：合并验收在 **2.25s** 内于 PM 阶段失败，
  断言输出 `编排失败：omp 退出码 1：… No API key found for deepseek`。
  失败发生在任何 push / PR 之前，**远程零污染**（已核对：远端无 `ai/*` 分支、无遗留验收 PR）。
- `OmpAdapter` 默认模型为 `deepseek-v4-flash`（`src/execution/adapters/omp.ts`），
  故解除阻塞只需注入 `DEEPSEEK_API_KEY`（或改用已授权的其它模型）。

**2）本次修掉的真实缺陷：Agent 提交继承了操作者的全局签名配置**

在本机跑 `pnpm run check` 时 `git-workspace.test.ts` / `effects.test.ts` 挂在
`Hook timed out in 10000ms`。逐项二分全局 git 配置（fsmonitor / untrackedcache /
push.autosetupremote / credential helper / 签名）后定位到**唯一**变量是
`commit.gpgsign=true` + `gpg.ssh.program`：

| 配置 | 结果 |
|---|---|
| neutral（`GIT_CONFIG_GLOBAL=/dev/null`） | 13 passed |
| **signing** | **1 failed** |
| fsmonitor+untrackedcache | 13 passed |
| push.autosetupremote | 13 passed |
| credential helpers | 13 passed |

这不只是测试环境问题，是**产品缺陷**：`GitWorkspace.commitAll` 已经用 `-c` 把身份钉成
`Keel <keel@localhost>`，却没钉签名 —— 于是机器署名的提交会被**操作者的密钥**签上人的身份；
且签名程序一旦交互提示或变慢，在无人干预的编排循环里等同于挂起
（正是本次观察到的 5s → 24s → 超时）。

修复：`src/fact/git-workspace.ts` 的 `commitAll` 增加 `-c commit.gpgsign=false`；
5 个夹具的 seed 提交同样显式关闭签名（`git-workspace` / `effects` /
`orchestrator-workspace` / `ci-wiring` / `v01-criterion`）。

**反例验证**（遵循「未经反例验证的检查，等同于没有检查」）：新增测试
`真实提交 > 不继承全局签名配置`——把全局配置换成「强制签名 + 必然失败的签名程序」，
断言 `commitAll` 仍成功且 `%G?` 为 `N`（无签名）。
去掉 `-c commit.gpgsign=false` 后该测试**确实失败**，恢复后通过。

**3）验证结果**

- `pnpm run check` **全绿**（exit 0）：lint / typecheck / boundaries（90 模块 382 依赖，0 违规）/
  check:generated / check:transitions（31 条）/ check:purity（9 文件 8 类）/
  **16 个测试文件 182 passed | 4 skipped**。
- 附带收益：测试总时长由 **32.0s 降到 2.9s** —— 此前每个 git 提交都在等签名程序。
- 四条架构约束未放宽，转移表未动，`C-002` 未触碰。

**4）待办（需主会话执行）**

- 上述代码修复**尚未提交**（子代理纪律：禁止 `git commit`）。变更文件：
  `src/fact/git-workspace.ts`、`src/fact/git-workspace.test.ts`、
  `src/control/driver/effects.test.ts`、`src/e2e/orchestrator-workspace.test.ts`、
  `src/control/orchestrator/ci-wiring.test.ts`、`src/acceptance/v01-criterion.acceptance.test.ts`。
- 合并验收待注入 `DEEPSEEK_API_KEY` 后重跑。**注意不要**按早前建议加
  `GIT_CONFIG_GLOBAL=/dev/null`：那会同时屏蔽 `gh` 的 credential helper 而使 push 失去鉴权；
  签名干扰已在代码里根治，直接用环境默认配置即可：

  ```bash
  export KEEL_GITHUB_TOKEN="$(gh auth token)"
  export KEEL_TEST_REMOTE_REPO=https://github.com/jionpz/keel
  export DEEPSEEK_API_KEY=...          # 当前缺失，阻塞点
  gh auth setup-git
  pnpm run test:acceptance src/acceptance/v01-criterion-github.acceptance.test.ts
  ```

### 2026-08-27（第二轮）· Opus 验收子代理：推理网关解锁，抓出**判据级**缺陷

**结论：合并验收 = blocked，但阻塞点已从「第一步」推进到「最后一步」——
真实 push 之后的 PR 创建被环境 token 拒（HTTP 403）。
在此之前的全链路（真实 LLM 驱动 `S-NEW → S-REVIEW` + 真实 push）**首次真正跑通**。**

> 更重要的是：这一轮发现此前所有「判据已达成」的记录都建立在一个**无效证明**上。
> 详见下面第 1 节。

#### 1）本轮的核心发现：Agent 从来没看见过上下文（判据级缺陷，已修）

**现象**（第一次真实运行，`OPENCODE_API_KEY` 解锁 omp 网关后）：
PM 阶段落库的 `A-StageOutcome` 写着

> `verdict: unclear` / `reason: 本次对话中不存在任何用户反馈原文，无法判断其内容与价值。`

**根因**（`src/execution/session/manager.ts` 的 `withPrompt`）：
它在追加阶段指令时**替换掉了整个 `context.sections`**，
于是 ContextBuilder 造好的 `role` / `feedback` / `rfc` / `state` 全被丢弃，
模型只收到阶段指令。而阶段指令写的是「判断**上面的**用户反馈是否值得做」——
上面什么都没有。

**为什么这是判据级而不是普通 bug：**

| | |
|---|---|
| ContextBuilder 是 Fact → Execution 的**唯一下行桥** | 桥断了，Fact Plane 的一切都没进模型 |
| `ContextBuilt` 事件是「Agent 当时到底看到了什么」的**唯一答案**（§2.2、`O3`） | 它记录的 section 根本没进提示词 —— **`O3` 记的是假话** |
| 判据要求「一条真实的**用户反馈**进入系统后……」 | 反馈从未进入执行侧，走完全程的是**阶段指令模板自己** |

**为什么此前所有确定性测试与本地验收都是绿的：**
阶段提示词里带着强暗示（如 PM 的「这是一个明确、范围很小的需求，应判为 actionable」），
模型照着暗示答即可通过；`session-pipeline.test.ts` 的桩只读 `sections[0]`，
而缺陷发生时 `sections[0]` 恰好就是 prompt。**整条链路上没有任何一处断言
「ContextBuilder 造的东西真的到达了 Adapter」** —— 又一次「未经反例验证的检查」。

**修复**：`withPrompt` 改为**追加**（原 section 在前、阶段指令在后 ——
「上面的」是语义的一部分），并同步重算 `total_tokens`（记账与内容不一致
会让预算判断建立在假数上）。

**反例验证**（两条测试，各守一个失败模式，均已确认「去掉修复就变红」）：

| 测试 | 守的是 | 反例 |
|---|---|---|
| `session-pipeline.test.ts` ·「阶段指令是追加而非替换」 | Manager 不得丢弃 ContextBuilder 的产出 | 改回 `[promptSection]` → 红（`['prompt']` ≠ `['feedback','prompt']`） |
| `adapters.test.ts` ·「renderPrompt —— 每个 section 都要真的进提示词」 | Adapter 必须渲染**全部** section，且指令在最后 | 改成 `sections[0]?.content` → 红（`KEEL_MARKER_FEEDBACK` 消失） |

后者用注入的 `spawnFn` 抓 omp 的 argv 末位（**模型实际收到的字节**），
不起进程、不花钱、进默认 `check`。

**修复后的实证**（同一条反馈，真实运行）：RFC 的 `problem` 字段变成

> 用户反馈：导出的 Excel 希望能够按照日期筛选。当前导出接口没有任何筛选参数（**见 README**）……

—— 同时引用了注入的反馈与工作区里的 README，证明下行桥真的通了。

#### 2）第二个发现：合并验收的夹具对目标仓库不成立

修好上下文后，Developer 与 QA 立刻如实报告：

> 工作区为 Keel（AI 编排运行时），**不存在 ExportService、导出 API 或任何 Excel/导出功能**
> （已核对 src/、migrations、package.json、docs、.trellis）……

**它们是对的，错的是夹具。** 本文件克隆的是 `KEEL_TEST_REMOTE_REPO`（Keel 自己），
而本地版 `v01-criterion` 铺的是一个写着「导出模块」的**合成仓库** ——
两者能用的反馈不是同一条，此前这里照抄了本地版的。
缺陷期间它「能过」，正是因为 Agent 什么都看不见。

期间还验证了一条夹具选择原则：换成「README 没写 `pnpm run timeline` 用法」后，
PM 报「前提不成立：package.json 与 scripts/ 中均不存在该命令」——
**也是对的**，因为 `timeline` 是本任务才加的、尚未合并进 main。
**夹具只能引用目标仓库 main 上已有的事实。**

最终夹具（已写入测试并附理由）：README 的「开发」一节只写 `pnpm install` + `pnpm run check`，
却没说 check 里的不变量测试需要真实 Postgres、本地还得先 `pnpm run db:migrate`
（CI 的 workflow 专门起了 postgres service 可佐证）。真实、可核验、且是**纯文档改动** ——
PR 要过的 CI 就是 `pnpm run check`，让模型去改被四条架构约束盯着的源码，
验证的就不再是编排闭环了。

#### 3）合并验收的实际结果（`v01-criterion-github`，2026-08-27，耗时 2m04s）

**无人干预走通到 `S-REVIEW`，真实 push 成功，PR 创建被拒：**

| 阶段 | 转移 | 结果 |
|---|---|---|
| PM | `T-002` → `T-004` | `actionable` |
| RFC 起草 + 冻结 | `T-011` | `FreezeRfc` 副作用落地 |
| Policy | `T-012` | `auto_develop`（`default_applied: false`） |
| develop | `T-017` | `implemented` |
| QA | `T-018` | `pass` |
| review | — | `pass` |
| **CreatePullRequest** | — | **push 成功 → PR API `HTTP 403`** |

阻塞点是**环境 token 的权限边界**，不是代码：
本云环境的 GitHub App token 可经 git credential 完成 push（已单独探针验证：
推一个临时 `ai/` 分支再删除，成功），但 REST API 侧 `repos/jionpz/keel`
返回 `permissions: {admin:false, maintain:false, pull:false, push:false, triage:false}`，
创建 PR 被拒。（Cloud Agent 的 `gh` 按设计是只读的。）

**系统在这一步的行为完全符合规范**：403 → `AUTH_FAILED`（`retryable=false`）
→ 直接失败不重试，与 `.trellis/spec/backend/error-handling.md` 的
「`AUTH_FAILED` 凭据失效，直接升人工，不重试」一致。

**远程零污染**：测试自带的 `finally` 清理生效，`git ls-remote 'refs/heads/ai/*'`
为空，无遗留验收 PR（仅本任务自身的 PR #27）。

#### 4）本地版 `v01-criterion` 回归：**通过**（134s）

上下文修复改动的是所有真实 LLM 路径，必须确认没有把本地闭环搞坏。
实测通过，且这一次是**有意义地**通过 —— 见第 1 节末尾的 RFC 引用实证。
（此前它的绿是靠提示词暗示蒙对的。）

#### 5）验证结果

- `pnpm run check` **全绿**（exit 0）：lint / typecheck / boundaries（92 模块 384 依赖，0 违规）/
  check:generated / check:transitions / check:purity（9 文件 8 类）/
  **16 个测试文件 185 passed | 4 skipped**（较上轮 +3，即本轮新增的反例验证测试）。
- 四条架构约束未放宽，转移表未动，`C-002` 未触碰。

#### 6）待办（需主会话执行）

- 本轮代码修复**尚未提交**（子代理纪律）。变更文件：
  - `src/execution/session/manager.ts` —— 上下文修复（**产品缺陷**）
  - `src/e2e/session-pipeline.test.ts`、`src/execution/adapters/adapters.test.ts` —— 两条反例验证测试
  - `src/acceptance/v01-criterion-github.acceptance.test.ts` —— 夹具修正 + 理由
- **父任务 `08-23-v01-closed-loop/prd.md` 的首条勾选需要修订。** 它现在写着
  「端到端判据达成…… 本地闭环 `v01-criterion` 已实测通过（真实 OMP session 驱动全程）」——
  该结论在**上下文缺陷修复之前**做出，当时 Agent 收不到任何 Fact Plane 内容，
  因此那次通过**不构成判据的证明**。修复后本地版已重新实测通过（本节第 4 点），
  结论本身仍成立，但**证据要换成修复后的这一次**，并记下这段历史 ——
  否则「判据达成」的依据仍指向一次无效运行。
- 合并验收的**最后一步**待一个有 PR 创建权限的 token 重跑：

  ```bash
  export KEEL_GITHUB_TOKEN=<有 pull-requests:write 的 token>
  export KEEL_TEST_REMOTE_REPO=https://github.com/jionpz/keel
  export OPENCODE_API_KEY=...     # 本轮即靠它解锁 omp 网关，deepseek key 非必需
  gh auth setup-git
  pnpm run test:acceptance src/acceptance/v01-criterion-github.acceptance.test.ts
  ```
