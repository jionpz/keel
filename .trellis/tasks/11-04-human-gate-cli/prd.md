# 人工介入入口：keel decide / keel answer + 控制台可复制命令

## 背景

状态机里人工闸门是定义好的：

| 转移 | from | event | to |
|---|---|---|---|
| `T-014` | `S-HUMAN_REVIEW` | `HumanApproved` | `S-DEVELOPING` |
| `T-015` | `S-HUMAN_REVIEW` | `HumanRejected` | `S-REJECTED` ★ |
| `T-016` | `S-HUMAN_REVIEW` | `HumanRequestedRework` | `S-BRAINSTORM` |
| `T-007` | `S-NEED_CLARIFICATION` | `ClarificationReceived` | `S-PM_ANALYZING` |

但**没有任何生产代码发出这四个事件**：CLI 没有对应命令，控制台按设计只读
（`keel_control` 只 `SELECT`、非 GET 一律 405）。结果是任务停在 `S-HUMAN_REVIEW`
就永久卡住，`S-NEED_CLARIFICATION` 只能等 TTL 到期被收成 `S-ABANDONED`。

## 目标

给这两个人工闸门补上可用的入口，同时**不改变控制台只读的安全边界**。

## 需求

### R1 `keel decide <task-id> <approve|reject|rework> [--note <text>]`

- 调用 `WorkflowDriver.advance(taskId, {type}, now)`，走既有转移表与副作用。
- `--note` 是可选的人类理由；成功转移后作为一条 `HumanDecision` 事件落库，
  让「为什么批准 / 为什么驳回」在时间线里可查。
- 任务不在 `S-HUMAN_REVIEW`（或 `control_mode` 导致该转移不匹配）时不写任何东西，
  打印当前状态与可用命令，退出码非 0。
- 转移成功后打印下一步：`keel run-task <task-id>` 继续驱动。

### R2 `keel answer <task-id> --text <text>`

- 在 `S-NEED_CLARIFICATION` 上：新建 `feedback(source='manual')` 并链接到该 task，
  取消澄清 timer，状态 → `S-PM_ANALYZING`，创建 `run(pm, n+1)`（`T-007`）。
- 三步必须在**同一个事务**内完成：要么澄清答复与状态变更一起落地，
  要么都不落地（不变量 I4）。
- 任务不在 `S-NEED_CLARIFICATION` 时同上：不写、报错、退出码非 0。

### R3 控制台显示可复制的命令

- 详情页在 `S-HUMAN_REVIEW` / `S-NEED_CLARIFICATION` 时显示一条「需要人工」提示条，
  内含按当前状态生成的可复制命令（复用现有 `copy-btn`，不新增写路径）。
- 控制台仍然只读：`POST` 依旧 405，不新增任何写端点。

## 非目标

- 控制台上直接点按钮改变任务状态（需要给无鉴权本地页面开写路径，是另一条设计决策）。
- 通知渠道（邮件 / IM / webhook）。
- 批量裁决、`--note` 富文本或附件、澄清多轮追问的会话式交互。

## 验收标准

- [ ] AC1 `keel decide <id> approve` 在 `S-HUMAN_REVIEW` 上产出 `T-014`：
      状态 → `S-DEVELOPING`，新建一条 `PENDING` 的 `develop` run，事件流新增 `TaskStatusChanged`。
- [ ] AC2 `keel decide <id> reject --note "理由"` → `S-REJECTED`（终态，I8），
      事件流含 `HumanDecision` 且 payload 带该理由。
- [ ] AC3 `keel decide <id> rework` → `S-BRAINSTORM`，新建 `brainstorm` run。
- [ ] AC4 在非 `S-HUMAN_REVIEW` 状态执行 `decide`：退出码非 0，提示当前状态，
      **数据库零写入**（事件数、run 数、状态均不变）。
- [ ] AC5 `keel answer <id> --text "..."` 在 `S-NEED_CLARIFICATION` 上：
      新增 `feedback(source='manual')` 与 `task_feedback` 关联、澄清 timer 被取消、
      状态 → `S-PM_ANALYZING`、新建 `pm` run；三步同事务（中途失败全部回滚）。
- [ ] AC6 控制台详情页在这两个状态下显示「需要人工」提示条与可复制命令；
      `POST /api/tasks` 仍返回 405。
- [ ] AC7 `pnpm run lint` / `pnpm run typecheck` / `pnpm test` 全绿。

## 备注

- 命令的中文帮助与错误文案和现有 CLI（`run-task` / `status`）保持一致：
  先给事实（当前状态、可用动作），再给下一步命令。
- `--note` 不进 prompt、不参与守卫判断 —— 它只是给人看的记录。
