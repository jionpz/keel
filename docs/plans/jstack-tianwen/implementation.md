# 实施进度：JT-01 只读影子链路

**日期**：2026-11-10。当前已实现可运行的协议与后台队列，并已通过两次 Pi 兼容 runner 的真实模型端到端烟测（root 手工 CLI 与完整入口各一次）；原生 OMP/Claude 的完整验收仍未完成，不是整个生产方案已完成。

## 已实现

- jstack `managed-export` 从自身 Question 路线、阶段表和只读 provider 导出协议包；文件缺失、路线不兼容或路径越界时拒绝。
- Keel 校验并持久保存包内容与摘要，既有任务不跟随本地包文件更新；仅支持 `investigation / execute`，不假装支持 L/XL 路线。
- `managed investigate/status/questions/answer/worker`：创建持久任务、查看问题和建议、接受真实本机操作者答复、后台自动继续。
- 调查执行产生 `read_files`、`waiting_decision` 或带引用的 `completed` 提案。模型没有原生工具；Linux FD 锚定读取只允许项目内受控普通文本，拒绝软链、隐藏/凭据路径、二进制和越界。
- 每个人工问题先执行天问，保存建议或失败原因，再进入人工队列。**JT-01 是影子模式**：所有此类问题仍等真实用户；项目长期历史、摘要和委托代批尚未接入。
- 任务/问题/尝试/审计独立于旧 `S-*` 状态机；旧 poller/driver 不驱动它们。后台认领使用 PostgreSQL 行锁、租约和 fencing token，过期可重取、迟到结果不可提交。
- 答复与任务 READY 状态在同一事务提交；重复相同答复幂等，不同答复冲突；等待期间不占用模型会话。worker 轮询会自动恢复，无需用户再运行 run-task。
- 输出和引用校验、有限调用预算、连续协议/推理错误重试、上下文持久快照和终态不可变约束。

## 本机试运行

前提：Node 24、依赖已安装、PostgreSQL 全部迁移；已安装所选 OMP/Claude CLI 并配置相应推理凭据。凭据不在命令行传入。以下是开发环境命令，`REPO_UUID` 和 `QUESTION_UUID` 取实际输出。

```bash
# jstack 仓库：导出只读调查包
./jstack managed-export > /tmp/jstack-investigation.json

# Keel 仓库：指定你自己的开发数据库并迁移
DATABASE_URL=postgres://localhost/keel_dev pnpm run db:migrate

# 为已有、由管理员绑定本地目录的 repo 创建调查
pnpm run keel managed investigate --repo REPO_UUID \
  --question '说明这个项目如何启动，并给出文件依据' \
  --package /tmp/jstack-investigation.json

# 常驻；根据实际安装选择 omp 或 claude
pnpm run keel managed worker --harness omp

# 另一个终端查看与答复；后台 worker 会自行接续
pnpm run keel managed questions --task TASK_UUID
pnpm run keel managed answer QUESTION_UUID --text '我的决定'
pnpm run keel managed status TASK_UUID
```

注册本地目录沿用已有 `register-repo --local-path`；没有绑定的 repo 不能创建此类任务。`managed worker --once` 只推进一次推理，可用于诊断；它不是“直接跑到终态”。

当前首发仅 Linux（要求 `/proc/self/fd`），单 task 默认最多 12 次模型调用，每次 90 秒并有清理宽限；上下文和文件读取有硬上限。未安装 Harness 时 worker 在认领前退出，任务保留 READY。

## 验收记录

### PR #84 历史验收（历史隔离环境，非当前结果）

以下数字是 PR #84 的历史验收记录，不代表 2026-11-10 的当前测试结果：

- Keel 新增 21 项确定性测试通过。
- 隔离 Node 24 / PostgreSQL 16 环境中，`pnpm run check && pnpm run build` 退出码 0；69 个测试文件，1002 项通过、5 项因缺少原生推理 CLI 跳过。
- jstack `./jstack check` 通过，包含 4 项 managed 导出测试与原有 123 项 hook/stage 检查；缺少 Claude CLI 的 manifest live 校验明确跳过。
- 实际 `jstack managed-export` 的产物被 Keel schema 接收，CLI 帮助与文档链接检查通过。

隔离运行用于排除云沙箱在 `/tmp/.git` 注入元数据对原有项目根目录测试的干扰，未改写或跳过该断言。精简测试镜像补齐了 Git 与 procps；运行项目检查未安装/改变项目依赖或锁文件。

确定性回归使用真实 PostgreSQL、临时文件和固定候选结果，验证协议、来源、租约、重复答复、恢复及权限，不将这些夹具当作真实模型验收。jstack 导出包也由 Keel schema 实际接收验证。

当时运行环境没有 `omp` / `claude` 与推理凭据（历史环境说明；当前环境见下一节），真实问题 → 模型查证 → 天问建议 → 人工答复 → 模型报告的验收仍未运行。

### 2026-11-10 本机验收

**macOS（darwin arm64，Node v24.14.1，PostgreSQL 16.15）**

- 收尾 review 前的快照（19:21）退出码 0：69 个测试文件，993 passed / 22 skipped；`pnpm run build` 退出码 0。证据：`.keel/coordination/2026-11-10/platform-result.md`、`platform-check-final.log`、`platform-build-final.log`。
- 收尾 review 后，主代理在本机主工作区重新执行最终 `pnpm run check` 与 `pnpm run build`（19:58），均退出码 0：69 个测试文件，993 passed / 22 skipped。这是最终检查，与上面的 19:21 收尾前快照是两次独立运行，分开记录。证据：`.keel/coordination/2026-11-10/integration-check.log`、`integration-build.log`、`integration.done`。
- 22 个 skip = 17 个 Linux-only managed 用例 + 5 个既有 skip。macOS 通过只证明非 Linux 能力门明确拒绝，不证明 managed 读取功能可用。

**Linux（Docker 官方 `node:24-bookworm-slim`，实际 Node 24.22.2，Linux arm64，真实 PostgreSQL 16）**

- 使用专用隔离库 `keel_jt01_linux_20261110_review`，未访问 `keel_dev`。
- 3 个 managed 测试文件真实执行：18 passed / 3 skipped，退出码 0。3 个 skip 都是非 Linux 能力门用例；17 条 Linux 专属用例全部真实执行并通过。
- 日志：`.keel/coordination/2026-11-10/linux-managed-check.log`。
- 未在 Linux 上运行完整 `pnpm run check`（只跑了 3 个 managed 测试文件），因此不宣称 full check 已在 Linux 通过。
- 容器内仅补齐两个锁定依赖：`@esbuild/linux-arm64@0.28.2`、`@rollup/rollup-linux-arm64-gnu@4.62.5`。两者从当前配置的 npm registry 下载，按 `pnpm-lock.yaml` 校验 SHA512，审查 manifest 确认无 install 脚本，并以隔离挂载提供；没有改根 `node_modules` 或 lockfile。

**控制台与巡检**

- console 真实页面脚本 / HTTP 回归与 patrol 针对性测试共 48 项通过。
- 已用 Chrome headless 查看 mock API 截图：人工标记、展开预览与主路径排版正常。该截图不连接真实数据库，也不等于真实 DB 写交互验收。
- 收尾 review 删除了 `src/cli/console.test.ts` helper 中 87 行未使用的 DOM/VM 桩与新增说明注释，测试断言保留；删除后 targeted 仍为 48 passed。证据：`.keel/coordination/2026-11-10/review-result.md`、`local-console-decision.png`。

**Pi 兼容 runner 真实烟测（2026-11-10，root 手工 CLI 与完整入口）**

这是**兼容 runner 烟测**，不是 Linux 原生 OMP/Claude 验收。本轮先由 root 手工执行真实 CLI 完成一次成功烟测（下文第一段）；`scripts/jt01/smoke.sh` 入口当时仍在收尾，随后也已由 root 用真实导出包和固定 Pi 副本完整执行通过（第二段）。总计两次成功兼容烟测，均不改变原生验收边界。

- 环境：Linux arm64，Node 24.22.2，Pi 1.5.1 固定目录副本（不随宿主 npm 安装更新），magpie 路由 `opencode-go/deepseek-v4.1-flash`，thinking=max。
- 专用隔离库 `keel_jt01_smoke_20261110_review`，未访问 `keel_dev`；任务 `ca653845-eca4-4076-a94d-0775f09c197a`，问题 `f0cbcb78-f0da-4e48-a550-a3fec41213bd`。
- 4 个真实 attempt 全部 `SUCCEEDED`，合计 tokens_in 19834 / tokens_out 1832。`cost_usd` 为 0 是最小配置的占位估算，实际账单未知；本轮不声称免费或费用验收通过。
- 真实事件顺序：`ManagedFilesObserved` → `ManagedDecisionRequested` → `TianwenSuggested` → `HumanAttentionRequested` → `ManagedHumanAnswered` → `ManagedTaskReady` → `ManagedInvestigationCompleted`。
- 恢复：`WAITING_HUMAN` 时先启动全新的常驻 worker，再用真实 CLI 提交测试操作者答复（选择 A：灯塔）；没有第二条手动 `tick` / `run-task`，常驻 worker 自动完成到 `DONE`。这是等待后新 worker 自动恢复的证据，不是崩溃中断点 SIGKILL 的真实故障注入，不扩展声称。
- 报告引用 `README.md`（digest `269efb3b…9e4c`）与 `release-choice.md`（digest `2753c661…e10c`）；root 重新读取实际字节计算 SHA256 并与观测记录比对，全部一致。
- 初次任务 `f1472904-f581-4f25-a3ea-df4018ea15f2` 同样完成提问/建议/答复；期间外部 Pi 安装从 1.4.0 替换为 1.5.1，容器原包 bind mount 失效，恢复 3 次 `HARNESS_UNAVAILABLE` 后 `FAILED`。该终态与审计完整保留，没有篡改；新任务使用固定副本重跑成功。
- 验收容器已停止；专用库、fixture 与证据保留。不是生产部署。证据：`.keel/coordination/2026-11-10/jt01-verified-evidence.json`。

**完整入口复跑（2026-11-10，root 实际执行）**

- root 实际执行：`PGHOST=/tmp/keel-reject-env PGPORT=1 sh scripts/jt01/smoke.sh --package <真实导出包> --pi-package <Pi 1.5.1 固定副本>`；外部 `PGHOST` / `PGPORT` 被故意设为错误的本机 socket / 端口，脚本仍访问明确指定的 `localhost:5432` 专用库，说明连接不随这两项环境变量漂移。
- 专用库 `keel_jt01_b27e641778a4`，未访问 `keel_dev`；任务 `d3a61e88-4b1e-4c49-b5e9-33e7a41221b9`，问题 `436e86ec-58a2-489b-9b70-f9d0fe35aab8`，问题已 `RESOLVED`，任务 `DONE`。
- 环境：Linux arm64，Node v24.22.2，Pi 1.5.1，目标模型 `opencode-go/deepseek-v4.1-flash`，thinking=max。
- 4 个真实 attempt 全部 `SUCCEEDED`，合计 tokens_in 16176 / tokens_out 1977；新常驻 worker 在答复后自动恢复到 `DONE`。`billing_cost_verified=false`，实际账单仍未知。
- root 另行连接该专用库核对真实 task / attempt / question 记录，并按 fixture 实际文件字节重新计算 SHA256；两份引用摘要一致，`citations_validated=true`。
- 容器已自动停止并移除；fixture 与专用库保留。证据：`.keel/jt01-smoke.6RFAMXuH/evidence.json`。

这两次成功都是 Pi 兼容 runner 烟测：第一次为 root 手工真实 CLI，第二次为 root 实际执行完整 `smoke.sh` 入口。二者都不是 Linux 原生 OMP/Claude 验收。

**边界与未完成**

- 本机有 Darwin 版 `omp` / `claude` CLI 与既有 magpie 网关；缺的是 Linux 原生 CLI。Pi 兼容 runner 烟测通过，不等于 Linux 原生 OMP/Claude 支持验收。
- 原生 CLI 缺口仍在；提问、等待、恢复、工具边界等支持矩阵与真实故障注入仍按原验收要求完成。#86 保持 open。
- `scripts/jt01/smoke.sh` 入口随后已由 root 用真实导出包与固定 Pi 副本完整执行通过；这是第二次成功的兼容烟测，仍不覆盖原生 OMP/Claude。可复跑流程见 `.keel/coordination/2026-11-10/jt01-result.md`，jstack 包用 `managed-export` 导出，Pi 包使用固定副本。
- #90 不解除 blocked，不启动 JT-02 实施。不把兼容 runner、确定性测试或 mock 截图当作原生 Harness 验收。

## 尚未实现

JT-02 至 JT-07：既有决定自动代答、正式委托策略、跨任务项目决定与摘要、完整工程路线/多 ticket、写操作网关、审批与撤销闭环、统一 daemon/控制台接入、备份演练、真实评测及受限生产试运行。不能把 JT-01 当作这些能力已经交付。
