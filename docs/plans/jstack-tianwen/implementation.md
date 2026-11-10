# 实施进度：JT-01 只读影子链路

**日期**：2026-11-10。协议与后台队列已实现，Linux 原生 OMP 真实烟测通过，
提问前与答复后两处 SIGKILL 故障恢复均已实测通过；原生 Claude 与 JT-02～07
尚未完成，JT-01 仍为影子模式，不能把 JT-01 当作完整交付。

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
  **JT-01 是影子模式**：所有此类问题仍等真实用户；
  项目长期历史、摘要和委托代批尚未接入。
- 任务/问题/尝试/审计独立于旧 `S-*` 状态机；旧 poller/driver 不驱动它们。
  后台认领使用 PostgreSQL 行锁、租约和 fencing token，过期可重取，迟到结果不可提交。
- 答复与任务 READY 状态在同一事务提交；重复相同答复幂等，不同答复冲突；
  等待期间不占用模型会话。worker 轮询会自动恢复，无需用户再运行 run-task。
- 输出和引用校验、有限调用预算、连续协议/推理错误重试、上下文持久快照和终态不可变约束。

## Harness 支持矩阵

| 能力 | 原生 OMP（Linux） | 原生 Claude | Pi 兼容 |
|---|---|---|---|
| 受控读取 / 真实问题 / 天问建议 | 已验 | 未验 | 已验（兼容） |
| 等待人工后新 worker 自动续跑 | 已验 | 未验 | 已验（兼容） |
| 原生工具禁用 | 已验 | 未验 | 不适用 |
| SIGKILL / 故障注入恢复 | 已验（提问前、答复后） | 未验 | 未验 |
| 结论 | JT-01 只读烟测与两处故障恢复通过 | 不声明支持 | 仅兼容烟测 |

原生 OMP 使用固定公共包副本直接执行，不经 Pi wrapper。
“原生工具禁用”只说明调查执行时不暴露 OMP 原生工具，
不等于具备写工具沙箱；Keel 不自行实现 coding agent，写路径隔离是 JT-02 前置。
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

## 验收记录

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
  与自然租约过期触发；原生 Claude 与 Pi 兼容 runner 未验，不得用“等待后重启 worker”
  替代中断点验收。
- 原生 Claude 未验收，不声明支持；Linux 原生 OMP 烟测不等于 Claude adapter 通过。
- JT-01 仍是影子模式：天问建议不自动代答，所有问题等真实用户；
  长期项目决定、摘要、正式委托与自动代答属 JT-02 及以后。
- Keel 不自行实现 coding agent；写路径隔离与写操作网关是 JT-02 前置，尚未实现。
  原生工具禁用不代表具备写沙箱。
- `#86` 验收已通过，待本 PR 合入后关闭；`#90` 前置验收已满足、尚未实施，
  状态以 GitHub tracker 为准。确定性测试、mock 截图和兼容 runner 都不能当作原生 Harness 验收。

## 尚未实现

JT-02 至 JT-07：既有决定自动代答、正式委托策略、跨任务项目决定与摘要、
完整工程路线/多 ticket、写操作网关、审批与撤销闭环、统一 daemon/控制台接入、
备份演练、真实评测及受限生产试运行。不能把 JT-01 当作这些能力已经交付。
