# 试运行就绪与支持矩阵

> JT-07 readiness 切片的实际约定。它回答“能否开始受限试运行”和“样本是否够 owner
> 复核”，不回答“模型正确率是否达标”。

## 1. 不变量

- 单 owner、单机：同一时刻最多一个进行中的试运行，不做多租户或账号体系。
- 试运行只记录观察窗口与项目绑定，不授予、扩大或自动续期任何动作授权。
- 样本必须来自真实台账：代决读 `managed_decision_resolution`，完成任务读
  `managed_ticket_task(status='DONE')`；不能用测试替身、历史回放或影子答案冒充。
- 达到门槛只输出 `eligible_for_owner_review`；生产准入仍需 owner 抽样复核与
  独立评测，不以日期自动扩权。
- 已停止的试运行不能通过连续试运行门槛；需要重新开始一轮。

## 2. 数据模型

`migrations/1000000000021_trial-readiness.sql`：

- `managed_trial(id, started_at, ended_at, stop_reason, note, created_at)`
  - `ended_at` 与 `stop_reason` 必须同时为空或同时非空；
  - `ended_at >= started_at`；
  - 部分唯一索引 `managed_trial_one_active` 保证只有一个 `ended_at IS NULL`。
- `managed_trial_project(trial_id, project_id)`
  - 项目必须已存在于 `repo`；
  - 每个试运行 2–3 个不同项目。

权限：`keel_control` 对 `managed_trial` 只有 `SELECT/INSERT/UPDATE`，对
`managed_trial_project` 只有 `SELECT/INSERT`；`keel_execution` 无读写权限。

## 3. 门槛与统计

| 门槛 | 值 | 来源 |
|---|---:|---|
| 项目数 | 2–3 | `managed_trial_project` |
| 连续时长 | 7 天 | `started_at` → `ended_at` 或当前时间 |
| 实际代决 | ≥30 | 窗口内 `managed_decision_resolution`，按 request revision 关联项目 |
| 完成任务 | ≥5 | 窗口内 `managed_ticket_task.status='DONE'` 的 `updated_at` |

额外风险信号：`open_questions` 统计 `OPEN/PROCESSING/WAITING_HUMAN`；`uncertain_actions`
与 `dead_letter_actions` 统计窗口内 `UNCERTAIN` / `FAILED` outbox。出现风险信号时
`trial-status` 给出复核提示，但不会自动判失败。

时间窗口边界：`started_at <= resolved_at/updated_at <= ended_at`；窗口外与其他项目的
样本一律排除。`by_project` 只列出本试运行绑定的项目。

## 4. CLI

```bash
keel doctor [--harness omp|claude|pi] [--json]
keel trial-start --projects UUID_A,UUID_B --confirm [--note TEXT]
keel trial-status [--json] [--require-eligible]
keel trial-stop --reason TEXT --confirm
```

`doctor` 只读：探测二进制/版本/capability/tier、凭据可判定性、数据库 schema、
GitHub 凭据、`git`/`pg_dump`、Linux `/proc/self/fd` managed 读取能力与试运行状态。
它不调用模型、不访问 GitHub、不认领队列，也不读取或输出 token。

支持矩阵口径：

| Harness | tier | 验证等级 | 说明 |
|---|---|---|---|
| OMP | L2 | `native-live` | Linux 原生真实模型、SIGKILL 恢复、工具负例与 ticket E2E |
| Pi | L0 | `compat-live` | 兼容 runner 真实烟测；原生 managed 写执行未验 |
| Claude Code | L2 | `deterministic-only` | adapter 契约/事件解析/spawn 门禁；原生 managed E2E 未验 |

`doctor.ok=false` 时列出硬阻断；凭据只能间接判定时不得写成“已验证”。当前实现中
OMP 不直接读 token：模型目录命中时凭据状态为 `unknown`，不命中时为 `missing`
（表示模型/凭据前提不满足）；Pi 用 `pi auth check --no-refresh`，Claude 用环境变量
或 `claude auth status --json`。

## 5. 测试与证据边界

确定性/集成测试覆盖：

- 纯门槛：`NOT_STARTED`、6/7 天边界、30 代决 + 5 完成任务、停止后不通过、
  负数/非整数样本拒绝、`uncertain`/dead-letter 提示。
- 真实 PostgreSQL：项目数量/重复/非法/不存在、单活试运行、窗口外与跨项目排除、
  open question 与 outbox 风险信号、`keel_execution` 权限负例、`keel_control` 无 DELETE。
- 迁移：专用库 `up → down 1 → up`。
- `doctor`：Linux/macOS managed 读取差异、Claude 未完成 live 验收时阻断、
  Pi/GitHub 缺凭据阻断、数据库不可用时不读取试运行、报告不泄漏 token。

不构成生产验收：本规范通过只证明工具与账本可用。真实 2–3 项目连续 7 天试运行、
30 个实际代决、5 个完成任务、留出评测集、独立评审、原生 Claude、XL 多 ticket、
生产故障注入与生产实例恢复仍必须单独执行。

