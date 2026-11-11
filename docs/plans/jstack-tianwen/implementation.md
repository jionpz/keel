# 实施进度：jstack 天问后台路线

**日期**：2026-11-11。协议与后台队列已实现，Linux 原生 OMP 真实烟测通过，
提问前与答复后两处 SIGKILL 故障恢复均已实测通过；JT-01～JT-06 已合入 `main`
（JT-06 为 PR #122，merge `1391dec`）。JT-07 的 `doctor` 支持矩阵与试运行账本
已实现并通过专用 PostgreSQL 库测试，但真实 2–3 项目连续 7 天试运行、30 个实际
代决、5 个完成任务与独立评测未完成；XL 未单独跑，原生 Claude 未验，JT-01 仍为
影子模式，不能把任何单项证据当作整套生产交付。

## JT-07 就绪矩阵与试运行账本（工具已实现，真实试运行未开始）

本切片只交付“能否开始受限试运行”的可观察工具，不把工具存在当成生产准入：

- `keel doctor [--harness omp|claude|pi] [--json]`：只读探测 Harness 二进制/版本/
  capability/tier、凭据可判定性、PostgreSQL schema、GitHub 凭据、`git`/`pg_dump`、
  Linux `/proc/self/fd` managed 读取能力与试运行门槛。不会调用模型、访问 GitHub、
  认领队列，也不会读取或输出 token。
- `keel trial-start --projects <uuid,uuid> --confirm [--note TEXT]`：把 2–3 个已登记
  项目绑定到一个试运行窗口；数据库唯一索引保证单 owner 同时只有一个进行中的试运行。
- `keel trial-status [--json] [--require-eligible]`：从真实
  `managed_decision_resolution`、`managed_ticket_task`、待答问题与 action outbox
  统计窗口内样本，输出 `RUNNING` / `STOPPED` / `NOT_STARTED`。
- `keel trial-stop --reason TEXT --confirm`：显式停止并保留样本；停止后的窗口即使
  时间与数量足够也不能通过连续试运行门槛。

门槛固定为：2–3 个项目、连续 7 天、至少 30 个实际代决、至少 5 个真实完成任务。
满足门槛只输出 `eligible_for_owner_review=true`，含义是“owner 可以开始抽样复核”，
不是“正确率达标”，也不会自动扩大授权、自动合并或自动部署。

迁移 `migrations/1000000000021_trial-readiness.sql` 新增 `managed_trial` 与
`managed_trial_project`。`keel_execution` 对两张表没有读写权限，`keel_control`
只能 SELECT/INSERT/UPDATE，不能 DELETE；真实 PostgreSQL 集成测试覆盖项目数量/
重复/非法/不存在项目、单活试运行、30 次代决 + 5 个完成任务、窗口外与跨项目样本
排除、停止后不通过，以及 open question / `UNCERTAIN` / `FAILED` outbox 风险信号。

### 当前支持矩阵（doctor 输出口径）

| Harness | tier | 验证等级 | 当前结论 | 明确限制 |
|---|---|---|---|---|
| 原生 OMP | L2 | `native-live` | Linux 原生真实模型、SIGKILL 恢复与工具负例已验 | managed 读取仅 Linux `/proc/self/fd`；doctor 不读取 token |
| Pi | L0 | `compat-live` | 兼容 runner 真实烟测已验 | 不声明 `CAP-RESUME` / `CAP-STRUCTURED_OUTPUT`；原生 managed 写执行未验 |
| Claude Code | L2 | `deterministic-only` | adapter 契约/事件解析/spawn 门禁有确定性测试 | 原生 managed 真实 E2E 未验；未声明 `CAP-STRUCTURED_OUTPUT` |

`doctor` 的 `blockers` 才是当前环境的硬阻断。2026-11-11 macOS 本机实测：
`managed_read` 因无 `/proc/self/fd` 被阻断；`pi auth check --provider opencode-go`
返回 `not_ready`；OMP 模型目录不含默认选择器。三者均如实显示，不能用单测或兼容烟测
替代。真实试运行必须在 Linux 目标环境、凭据可用且 `doctor` 无阻断后，由 owner 明确
选择项目再启动。

## JT-06 统一后台、故障恢复和备份（已合入 main，PR #122）

`ai/jt06-service` 已实现：

- `keel serve` 默认统一运行 ingress、天问/managed、摘要草稿、timer/巡检、
  outbox 与 required checks；`--no-ingress` 可显式只处理持久化 managed 工作；
- `worker_health` 增量记录 `instance_id/pid/status/reason_code/detail/checkpoint/
  started_at/last_success_at`；每个角色独立退避重启，`service` 自身周期心跳避免
  长 tick 被误判过期；
- ticket/workflow/outbox claim 按项目先取最久未推进的一条，再全局取最旧，
  防止单项目垄断；既有租约/fencing 仍是提交前事实边界；
- SIGTERM/SIGINT 停止新认领，等待当前 tick/在途驱动收尾，再写 `STOPPED`、释放锁；
- `keel service-status` / `service-health` 为只读快照，输出必需角色、原因码、
  队列、待答问题、dead-letter 与 uncertain/blocking 动作；
- `keel backup` 在 REPEATABLE READ 导出的 PostgreSQL snapshot 上 `pg_dump`，
  复制被引用 blob 并写内容摘要 manifest；
- `keel restore-verify` 创建隔离库恢复，重新校验包摘要、队列、问题和 blob，
  对 `EXECUTING/UNCERTAIN`、缺 GitHub 凭据、待人工分别给出阻塞结论，不自动重放。

规范见 [service-runtime.md](../../spec/backend/service-runtime.md)。迁移
`migrations/1000000000020_service-runtime.sql` 已在全新 PostgreSQL 库执行
`up → down 1 → up`。确定性测试覆盖运行时故障隔离/退避/SIGTERM、健康只读、
公平调度，以及真实备份/隔离恢复/篡改/缺凭据/uncertain 场景。

## JT-05 授权生命周期与人工控制（已合入）

`ai/jt05-authorization` 已实现：

- `DelegationPolicyVersion` 发布/撤销只经本机 CLI 显式 owner + `--confirm`，写审计与
  项目记忆 epoch；天问和 worker 没有写入口；
- `ExecutionPermit` 绑定授权版本、项目授权 epoch、任务控制代次、预算快照与可选的
  decision request/revision/resolution/digest；
- `managed_execution_permit_available()` 统一校验 permit、策略、任务状态/代次、
  epoch、决定 revision/决议与 authority refs；实际动作前、permit 后、push 后创建
  PR 前都复核；
- `ticket-pause/cancel/resume`：立即阻断 `PENDING`/`LEASED` outbox、撤销 `VALID`
  permit、递增 `control_generation`、取消等待中的 decision request；对
  `EXECUTING` 只记录外部动作已开始的回查/补偿边界；
- `ticket-override`：先作废旧 revision、阻断未执行动作，再写 `human_confirmed`；
- must-stop/审批请求先进入天问；无精确委托时 `owner_required`，有精确委托默认时
  可 `delegated`；停止选项（含 must-stop 天问选择停止）一律转 `CANCELLED`；
- 高影响动作禁止任何 `*` selector（包括 `foo*` 前缀通配）；`max_attempts` 按
  outbox 真实认领次数校验，token/cost 预算仍拒绝自动许可；
- 已 `EXECUTING` 后人工暂停，迟到的成功结算保持 `PAUSED`/`CANCELLED` 并记录
  `external_action_completed`，不会自动改回 `PR_OPENED`。

迁移为 `migrations/1000000000019_authorization-lifecycle.sql`，已在专用 PostgreSQL
库执行 `up → down 1 → up`。规范见
[action-gateway.md](../../spec/backend/action-gateway.md)、
[decision-acceptance.md](../../spec/backend/decision-acceptance.md)、
[ticket-execution.md](../../spec/backend/ticket-execution.md)。

验证：全量 `pnpm run test` 为 90 个文件 / 1303 项通过、24 项跳过；
`typecheck`、`build`、`boundaries`、`check:transitions`、`check:purity`、`lint`
均通过；`src/generated/managed.ts` 可重复生成且与 schema 一致。

## JT-04 完整路线与多 ticket（已合入）

`ai/jt04-routing` 已实现：

- jstack `managed-export --route` 导出 XS/S/M/L/XL 五档、固定四阶段、9 个来源摘要
  与 archive gate；route planner 规则在 `src/managed/plan.md`；
- Keel route/ticket schema、`managed_workflow*` 迁移、图版本与 supersede；
- 计划校验覆盖规模/数量、依赖存在与循环、根节点、scope 越界、重复
  key/ticket/issue、provider profile 与来源摘要；
- 节点独立 worktree、依赖前沿调度、多个依赖的祖先一致性检查；
- ticket 执行绑定节点 scope/acceptance；execute 后按实际 changed files 拒绝越权改动；
- verify/review 证据按 stage、gate、节点 binding、输入 commit、diff、branch 复用；
  rework 使后续证据失效；
- branch_ready 与 pr_ready 的 archive 门、准确 head SHA、check gate 和阶段证据；
- managed issue claim 阻止同一 repo 的 issue 被多个 managed owner 重复占用；
- CLI `workflow-create/plan/status/list/tick/worker`；
- 控制台 `GET /api/workflows`、`GET /api/workflows/:id` 与
  `projection: jstack-managed-v1`；legacy `/api/tasks` 标 `legacy-v01`。

规范见 `docs/spec/backend/workflow-routing.md`。jstack 侧 PR #51 已开；
Keel 侧确定性验收：

- 新建专用 PostgreSQL 库完成迁移 `up → down 1 → up`；
- `route-protocol.test.ts` 9 项：五档、数量、依赖/循环/根节点、重复、scope、
  伪造摘要、ticket 包构建；
- `workflow-runtime.test.ts` 9 项：两 ticket 依赖链完成且 branch_ready 不产生
  outbox、等待人工不阻塞独立节点、人工答复后工作流自动恢复、verify 证据复用、
  暂停节点受控重试、图版本/supersede、同 issue 冲突、archive 缺证据拒绝、
  execute scope 越权拒绝；
- `ticket-runtime` 与 `ticket-protocol` 既有 17 项继续通过；
- `managed` CLI 创建/导入/查询/列出 workflow 通过；控制台 workflow API 通过。

真实 L 多 ticket E2E（2026-11-11，临时 PostgreSQL + 临时 git 仓库）：

- harness `pi`，模型 `opencode-go/deepseek-v4.1-flash`；
- jstack route planner 实际产出 `route_size=L`、2 个依赖 ticket；
- 两个 ticket 都真实执行 `execute → verify → review → land`，`node --test` 在
  worktree 内真实通过，最终 workflow `DONE`；
- 两个节点均 `ARCHIVED`，共 10 条 workflow 证据（每节点 5 阶段），
  `branch_ready` 不产生 push/PR action intent 或 outbox；
- E2E 暴露并修复了等待态不自动恢复、失败节点不可重试、模型自算证据摘要、
  `branch_ready` land 误请求 push/PR 四个问题。

**未完成**：XL 只做了规则与确定性测试，未单独跑真实模型 E2E；archive 只记录本地
关闭门，不自动关闭远程 GitHub Issue。

## JT-03 项目记忆（已实现）

`ai/jt03-memory` 已实现：

- `ProjectMemoryContent` schema 与生成类型；
- `managed_project_memory_state/summary/event/retrieval` 迁移，决定插入/替代/撤销
  自动 bump epoch，摘要发布/回滚/拒绝走 SECURITY DEFINER 单入口；
- 确定性摘要构建、schema/权威快照校验、同一关键词冲突标注；
- 按项目检索 ACTIVE 摘要，stale 时用当前决定覆盖并追加增量；
- 关键候选预算不足明确升级，非关键省略与检索预算写审计日志；
- ticket 天问上下文从“全量项目决定”改为摘要 + 增量检索，接纳器仍读取完整权威决定；
- 人工 `human_confirmed` 答案显式提升为 owner_confirmed 项目规则；
- `memory-status/summary/publish/reject/rollback/retrieve/promote` CLI。

规范见 `docs/spec/backend/project-memory.md`。已在全新专用 PostgreSQL 库完成
`up → down 1 → up` 迁移和真实 store 验收；`memory-protocol` 13 项、`memory-store`
16 项、`decision-store` 11 项、`ticket-runtime` 11 项测试通过。全量 `pnpm run test`
为 88 个文件 / 1265 项通过；`typecheck`、`build`、`boundaries`、`check:transitions`、
`check:purity` 均通过。

## 已实现

- jstack `managed-export` 从自身 Question 路线、阶段表和只读 provider 导出协议包；
  文件缺失、路线不兼容或路径越界时拒绝。
- Keel 校验并持久保存包内容与摘要；既有任务不跟随本地包文件更新；
  仅支持 `investigation / execute`，不假装支持 L/XL 路线。
- `managed investigate/status/questions/answer/worker`：创建持久任务、查看问题与建议、
  接受真实本机操作者答复、后台自动继续。
- 调查执行产生 `read_files`、`waiting_decision` 或带引用的 `completed` 提案。
  模型没有原生工具；Linux FD 锚定读取只允许项目内受控普通文本，
  拒绝软链、隐藏/凭据路径、二进制和越界。
- 每个人工问题先执行天问，保存建议或失败原因，再进入人工队列。
  **JT-01 调查子链路仍是影子模式**：此类问题仍等真实用户；项目长期历史、摘要与
  委托代批在 JT-02+ 的 ticket/workflow 路径生效，两条路径不能混写。
- 任务/问题/尝试/审计独立于旧 `S-*` 状态机；旧 poller/driver 不驱动它们。
  后台认领使用 PostgreSQL 行锁、租约和 fencing token，过期可重取，迟到结果不可提交。
- 答复与任务 READY 状态在同一事务提交；重复相同答复幂等，不同答复冲突；
  等待期间不占用模型会话。worker 轮询会自动恢复，无需用户再运行 run-task。
- 输出和引用校验、有限调用预算、连续协议/推理错误重试、上下文持久快照和终态不可变约束。

## Harness 支持矩阵

| 能力 | 原生 OMP（Linux） | 原生 Claude | Pi |
|---|---|---|---|
| 受控读取 / 真实问题 / 天问建议 | 已验 | 未验 | 兼容 runner 已验 |
| ticket 写执行到 `pr_ready` | 原生真实 E2E 已验（JT-02） | 未验 | 原生 managed 未验 |
| 等待人工后新 worker 自动续跑 | 已验 | 未验 | 兼容 runner 已验 |
| 原生工具禁用 / 写边界 | 已验（JT-01 负例 + JT-02 隔离） | 未验 | 未验 |
| SIGKILL / 故障注入恢复 | 已验（提问前、答复后） | 未验 | 未验 |
| 结论 | `native-live` | `deterministic-only` | `compat-live` |

原生 OMP 使用固定公共包副本直接执行，不经 Pi wrapper。
“原生工具禁用”只说明 JT-01 调查执行时不暴露 OMP 原生工具；ticket 写路径的
Executor 环境 allowlist、容器规格与 scope 检查由 JT-02 实现，见
[executor-isolation.md](../../spec/backend/executor-isolation.md) 与
[ticket-execution.md](../../spec/backend/ticket-execution.md)。
2026-11-10 实际负例：原生 OMP 18.11.1 + 目标模型 max + `--no-tools`
请求 `bash` 创建 `/tmp/jt01-native-tool-escape`，原生 CLI 返回
`Tool bash not found`，模型最终 `tool_unavailable`，容器内 marker 不存在，容器已停止。
`tool_execution_start` 事件只能记录尝试，不能等同实际工具执行；写工具沙箱仍未实现。
证据：`.keel/native-tools.A85ly7/evidence.json`。
macOS 上 managed 读取按能力门拒绝，符合设计，不证明读取功能可用。

## Linux 本机试运行

前提：Linux（`/proc/self/fd` 可用）、Node 24、依赖已安装、PostgreSQL 可用；
OMP/Claude CLI 与推理凭据已配置，凭据不在命令行传入。macOS 不适用本页读取路径，
不要按下列命令做 Linux 验收。迁移与后续 `worker` / `status` / `answer`
必须指向同一个专用库。连接串取值顺序是 `KEEL_DATABASE_URL ?? DATABASE_URL ?? 默认库`；
真正的问题是只在迁移命令前临时赋值不会传给后续命令。已 `export` 的 `DATABASE_URL`
同样可用；以下示例显式 `export KEEL_DATABASE_URL`。
真实烟测使用一次性专用库并保留证据，`REPO_UUID` 和 `QUESTION_UUID` 取实际输出。

```bash
# jstack 仓库：导出只读调查包
./jstack managed-export > /tmp/jstack-investigation.json

# Keel 仓库：创建专用库并迁移；后续 CLI 读 KEEL_DATABASE_URL
createdb keel_jt01_dev
export KEEL_DATABASE_URL=postgres://localhost:5432/keel_jt01_dev
DATABASE_URL="$KEEL_DATABASE_URL" pnpm run db:migrate

# 为已有、由管理员绑定本地目录的 repo 创建调查
pnpm run keel managed investigate --repo REPO_UUID \
  --question '说明这个项目如何启动，并给出文件依据' \
  --package /tmp/jstack-investigation.json

# 常驻；根据实际安装选择 omp 或 claude
pnpm run keel managed worker --harness omp

# 另一个终端查看与答复；新终端也要先 export 同一个 KEEL_DATABASE_URL
pnpm run keel managed questions --task TASK_UUID
pnpm run keel managed answer QUESTION_UUID --text '我的决定'
pnpm run keel managed status TASK_UUID
```

注册本地目录沿用已有 `register-repo --local-path`；没有绑定的 repo 不能创建此类任务。
`managed worker --once` 只推进一次推理，可用于诊断；它不是“直接跑到终态”。
当前首发仅 Linux（要求 `/proc/self/fd`），单 task 默认最多 12 次模型调用，
每次 90 秒并有清理宽限；上下文和文件读取有硬上限。
未安装 Harness 时 worker 在认领前退出，任务保留 READY。

进入 JT-07 试运行前，先用同一个专用库执行只读就绪检查；`doctor` 的阻断项未清零
时不要启动试运行：

```bash
pnpm run keel doctor --harness omp
pnpm run keel trial-start --projects REPO_UUID_A,REPO_UUID_B --confirm
pnpm run keel trial-status
# 连续 7 天、30 个实际代决、5 个完成任务后，owner 抽样复核
pnpm run keel trial-status --require-eligible
pnpm run keel trial-stop --reason '本轮试运行结束' --confirm
```

`trial-status` 的 `eligible=true` 只表示可以开始 owner 复核，不是生产准入，
也不会自动扩大授权。

## 验收记录

### JT-07 readiness 切片（2026-11-11）

- 专用 PostgreSQL 库 `keel_jt07_1794399031`：22 个迁移全部执行；`0021` 单独执行
  `up → down 1 → up` 成功。
- macOS 本机 `pnpm run check`：98 个测试文件，1337 passed / 24 skipped；
  `pnpm run build` 通过。
- 新增 `trial` 纯门槛 5 项、`trial-store` 真实 PostgreSQL 4 项、`doctor` 6 项；
  覆盖项目数量/重复/非法/不存在、单活试运行、30 代决 + 5 完成任务、窗口外/跨项目
  排除、停止后不通过、权限负例与风险信号。
- `keel doctor --harness omp --json` 与 `keel trial-status --json` 已在专用库烟测。
  macOS 实测如实报告 `managed_read`、Pi `opencode-go` 凭据与 OMP 模型目录阻断，
  没有把单测或兼容烟测当成 Linux 原生验收。
- 未开始真实 7 天试运行；没有 30 个实际代决、5 个真实完成任务或评测样本。

### PR #84 历史验收（历史隔离环境，非当前结果）

以下数字属于 PR #84，不代表 2026-11-10 的当前测试结果：

- Keel 新增 21 项确定性测试通过。
- 隔离 Node 24 / PostgreSQL 16 环境中，`pnpm run check && pnpm run build` 退出码 0；
  69 个测试文件，1002 项通过、5 项因缺少原生推理 CLI 跳过。
- jstack `./jstack check` 通过，包含 4 项 managed 导出测试与原有 123 项 hook/stage 检查；
  缺少 Claude CLI 的 manifest live 校验明确跳过。
- 实际 `jstack managed-export` 的产物被 Keel schema 接收，CLI 帮助与文档链接检查通过。

隔离运行用于排除云沙箱在 `/tmp/.git` 注入元数据对原有项目根目录测试的干扰，
未改写或跳过该断言。精简测试镜像补齐了 Git 与 procps；
运行项目检查未安装/改变项目依赖或锁文件。
当时环境没有原生 `omp` / `claude` 与推理凭据，真实模型闭环未运行。

### PR #96 Linux 完整 CI（历史）

- Linux 完整 CI：69 个测试文件，1007 passed / 8 skipped；
  17 条 Linux-only managed 用例全部真实执行。
- macOS：993 passed / 22 skipped（17 个 Linux-only + 5 个既有 skip）。
- Linux full check 已通过；macOS 通过只证明非 Linux 能力门拒绝，不证明 managed 读取可用。

### 当前 PR 本机完整检查（2026-11-10）

- macOS 本机 `pnpm run check` 实际通过：69 个测试文件，993 passed / 22 skipped；
  `pnpm run build` 通过。
- Linux 完整 check 等本 PR 的 CI 结果；#96 的旧结果不作为本 PR 证据。

### 原生 OMP 真实烟测（2026-11-10）

- 环境：官方 `node:24-bookworm-slim`，Linux arm64，Node 24.22.2，
  原生 OMP 18.11.1 + Bun 1.4.4；使用固定公共包副本，不经 Pi wrapper。
- 真实入口：`sh scripts/jt01/smoke.sh --runner native-omp --package <真实导出包> --omp-node-modules <固定目录> --bun-package <Linux Bun package>`。
- 专用库 `keel_jt01_f683aaf47c0c`，任务 `3e8d59a3-5c42-4c65-8b68-ae3eee37bd39`，
  问题 `241e5f76-9654-4224-adac-2bf8ead2d351`；4 个 attempt 全部 `SUCCEEDED`。
- 真实顺序：读取 → 提问 → 天问建议 → 可信 CLI 提交测试操作者答复 →
  新常驻 worker 自动完成 `DONE`。
- 合计 tokens_in 24873 / tokens_out 4716；`cost_usd` 是占位估算，实际账单未知。
- root 独立查库核对任务/问题/尝试/事件，并按实际文件字节重算 SHA256，
  两份引用摘要匹配。
- 证据：隔离树 `.keel/jt01-smoke.O0EHAg7D/evidence.json`；root 复核
  `.keel/coordination/2026-11-10/full-delivery/native-smoke-verified.json`。
  两者均为本地未提交证据。

### SIGKILL 故障恢复验收（2026-11-10，两处已验）

- 命令：`node scripts/jt01/fault-smoke.mjs --evidence <evidence.json> --bun-package <Linux Bun 包目录> --point before-question`；`--point` 另可取 `after-answer`。不是生产部署。
- 提问前：证据 `.keel/jt01-fault.Oi9jGf/fault-evidence.json`；任务 `0f04e812-c1b3-4a75-8fc8-8e7530c8da1f`，问题 `4979d439-b88d-497b-b19b-cc57cd949a34`。真实 worker 118 与原生 OMP 183 被 SIGKILL，退出 137；租约自然过期 120.099s；新常驻 worker 自动继续完成真实提问与天问建议，测试操作者经一次 CLI 答复后任务自动 `DONE`。
- 答复后：证据 `.keel/jt01-fault.nefSmv/fault-evidence.json`；任务 `e9846c22-f93b-4d81-a71f-650532f51d20`，问题 `526b83ce-f562-4210-91a8-f870cdd653a1`。先真实答复，再 SIGKILL 正在推理的 worker/OMP，退出 137；租约自然过期 120.054s；新常驻 worker 用同一 question 和同一 ANSWER 自动 `DONE`，无二次 tick。
- 两次被杀 attempt 均为 `TIMEOUT` + `owner lease expired` + `ManagedLeaseExpired`；其余 4 个 attempt 各 `SUCCEEDED`，含真实 tianwen；每任务仅一条 `ManagedHumanAnswered`。
- root 独立查询 PostgreSQL 并按实际夹具字节重算 SHA256，全部匹配；复核记录 `.keel/coordination/2026-11-10/full-delivery/fault-before-verified.json` 与 `fault-after-verified.json`。未修改租约或数据库时钟，未改动旧任务，容器已自动停止。实际账单未知；被杀推理的 usage 缺失，保留 `null`。
- 早期三次脚本运行分别因 preflight、进程识别和注入时序错误失败，均已修复；失败运行不计为通过，没有伪造结果。

### 控制台真实数据库验收（2026-11-10）

- 专用库 `keel_jt01_console_20261110_full`，
  任务 `6b90cbcb-0363-4146-a892-41bebad0250c`。
- 真实登录、展开 RFC 目标/验收条件与 diff、填写理由并批准，
  `POST /api/tasks/.../decide` 返回 HTTP 200。
- root 独立查库确认 `S-DEVELOPING`、`develop#2 PENDING`、Human Review TTL cancelled、
  `HumanDecision` 理由与 `T-014`、`CreateBranch` applied，
  实际 worktree 为 `ai/task-6b90cbcb`；刷新页面一致，
  900 宽无横向溢出，仅 favicon 404。
- 这是人工控制台真实交互，不是天问自动授权。
  证据：`.keel/coordination/2026-11-10/full-delivery/console-real-verified.json`。

### Pi 兼容历史烟测（两次，非原生）

- 两次均为 Linux arm64、Node 24.22.2、Pi 1.5.1 固定副本，
  模型 `opencode-go/deepseek-v4.1-flash`，thinking=max。
- 第一次 root 手工真实 CLI：专用库 `keel_jt01_smoke_20261110_review`，
  4 个 attempt 全 `SUCCEEDED`，tokens_in 19834 / tokens_out 1832；
  等待后新 worker 自动 `DONE`。
- 第二次 root 实际执行完整 `smoke.sh`：专用库 `keel_jt01_b27e641778a4`，
  4 个 attempt 全 `SUCCEEDED`，tokens_in 16176 / tokens_out 1977；同样自动恢复。
- 早先任务 `f1472904-f581-4f25-a3ea-df4018ea15f2` 因外部 Pi 安装从 1.4.0 替换为 1.5.1，
  容器原 bind mount 失效，3 次 `HARNESS_UNAVAILABLE` 后 `FAILED`；
  终态与审计完整保留，改用固定副本重跑成功。
- 两次都只是 Pi 兼容 runner 证据，不能关闭原生 OMP/Claude 验收；
  `billing_cost_verified=false`，实际账单未知。

## 边界与未完成

- SIGKILL/故障注入恢复仅覆盖原生 OMP 的提问前与答复后两处，均由真实 SIGKILL
  与自然租约过期触发；原生 Claude 与 Pi 原生 managed 路径未验，不得用“等待后重启 worker”
  替代中断点验收。
- 原生 Claude 未验收，不声明支持；Linux 原生 OMP 烟测不等于 Claude adapter 通过。
- JT-01 调查子链路仍是影子模式；JT-02+ 的 ticket/workflow 路径已有项目决定、
  正式委托与自动代答，不能反过来宣称 JT-01 调查也已自动代答。
- Pi 只有兼容 runner 烟测；原生 Pi managed 写执行、Claude managed E2E 与 XL
  多 ticket 路线均未验。
- JT-06 的备份恢复是真实 PostgreSQL + blob + 隔离库校验，但“生产实例恢复演练”
  仍未执行；真实数据库短断、重复 webhook、外部响应丢失等故障注入也未完成。
- 真实 2–3 项目连续 7 天试运行尚未启动；没有 30 个实际代决与 5 个真实完成任务，
  也没有留出评测集或独立评审，不能报告生产正确率。
- `#86`、`#90`～`#94` 已关闭；`#85` 与 `#95` 保持 open，状态以 GitHub tracker 为准。
  确定性测试、mock 截图和兼容 runner 都不能当作原生 Harness 或真实试运行验收。

## JT-07 仍未完成

- 真实试运行：由 owner 选择 2–3 个代表性项目，在 `doctor` 无阻断的 Linux 环境启动，
  连续运行至少 7 天并积累 30 个实际代决、5 个真实完成任务。
- 评测：留出问题、按时间/主题隔离、原始人类答复或独立评审标注，记录样本量、
  项目分布、错误分类与置信区间；天问不能自评。
- 生产故障注入：真实 SIGKILL、数据库短断、重复 webhook、外部响应丢失、旧 worker
  迟到、摘要回滚与撤销竞态。
- 原生 Harness：Claude managed E2E、Pi 原生 managed 写执行、XL 多 ticket 路线。
- 生产恢复：按目标部署环境执行一次完整备份恢复演练，并验证待答问题、outbox 与
  外部动作回查。
