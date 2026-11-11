# jstack 单 ticket 工程包与阶段执行器

> 范围：JT-02C / JT-04。Keel 消费 jstack 导出的固定 ticket 包，按
> `execute → verify → review → land` 执行；阶段执行器本身不 push、不创建 PR。
> 外部动作与 `pr_ready` 由 JT-02D/02E 的独立网关完成。
> 多 ticket 路线由 [workflow-routing.md](./workflow-routing.md) 定义。

## 1. 固定包

事实来源是 jstack 的 `managed-export --ticket-id ...`。包包含：

- `ticket`：稳定 ticket id、标题与可选正文（`description`，1..20000 字符）；
- `route`：`XS`/`S`/`M`/`L`/`XL` 与固定四阶段；route 图中的 managed 节点只取
  `XS`/`S`/`M`，整体 L/XL 由工作流拆成多个节点；
- `stages`：每个阶段的 provider 引用、provider 源路径、门禁、tool profile、
  完整 provider 指令与阶段内容摘要；
- `instructions`：route、阶段表、must-stop 全文；
- `tool_policy`：jstack 导出的阶段/能力/harness 映射与自身摘要；
- `must_stop`：动作表、hook 名与全文摘要；
- `completion_target`：`branch_ready` 或 `pr_ready`；后者必须继续经过受控网关；
- `sources`：所有固定来源的路径、SHA256 与字节数；
- `content_digest`：对整个包（排除该字段本身）做 canonical JSON SHA256。

jstack 交互式 XS/S 默认路线没有 review；managed 写路径强制加入 review 安全门。
包和文档都明确这是 managed launcher 的安全覆盖，不声称与交互式 route 完全相同。

Keel 在绑定时读取一次包并保存到 `managed_package`；运行期只按
`managed_ticket_task.package_digest` 读取数据库中的固定 body，不读取 jstack 工作区。
后续导出新包不会改变已绑定任务。

## 2. 绑定与工作树

`createManagedTicketTask` 校验：

- 包 schema、阶段顺序、阶段/provider/tool profile 交叉引用、所有内容摘要；
- worktree 是真实路径、非符号链接、独立 git 顶层；
- 复用 JT-02A 的 `inspectWorkspaceIsolation` 检查受保护路径与共享临时目录边界；
- worktree 干净；
- baseline commit 存在且精确等于绑定时的 HEAD。

任务永久保存 `package_digest`、`baseline_commit`、`worktree_path`、ticket id/title
与 `completion_target`；完整 ticket 正文随固定包保存在 `managed_package`。
数据库触发器禁止任务绑定字段被改写。

route 工作流还会把节点 `scope_paths` 与 `acceptance` 保存到
`managed_workflow_node`，并在阶段上下文里提供；ticket 任务本身的固定包摘要不变。

## 3. 阶段状态机

`managed_ticket_task.status`：

| 状态 | 含义 |
|---|---|
| `READY` | 可认领；按 `current_stage` 执行 |
| `RUNNING` | 已有 lease，worker 正在执行 |
| `WAITING_HUMAN` | 已生成 `DecisionRequest`，等待本机操作员 |
| `WAITING_GATEWAY` | `pr_ready` 的 land 已登记 action intent / outbox，等待受控 gateway |
| `PAUSED` | 缺包、协议不兼容、tool profile 缺失、工作树漂移或门禁失败 |
| `PR_OPENED` | gateway 已推送并创建/复用 PR，`handoff` 保存 PR 信息 |
| `CHECKING` | check gateway 正在按准确 PR head SHA 观测 required checks |
| `PR_READY` | PR 准确 head 的全部 required checks 显式成功，证据已持久化 |
| `PR_CHECKS_FAILED` | check 缺失/失败/超时，或 PR/worktree/permit/policy 证据不一致 |
| `DONE` | `branch_ready` 的 land 已写 branch/commit handoff；不创建 outbox |
| `FAILED` | 尝试预算耗尽等不可继续状态 |
| `CANCELLED` | 人工选择停止 |

每次认领插入一条 `managed_ticket_stage`，保存 stage、attempt、package digest、
baseline、输入 commit、输入摘要、输出摘要、证据摘要、结构化 result/evidence 与 usage。
已结束的阶段行不可改写。

## 4. 阶段门禁

| 阶段 | 门禁 |
|---|---|
| `execute` | 必须产生新 commit，commit 等于当前 HEAD，与输入 commit 不同，工作树干净 |
| `verify` | 至少一条 check；每条必须有 command、exit code、passed、输出摘要/摘录；`output_digest` 必须与实际摘录一致；HEAD 不能变化 |
| `review` | `reviewed_commit` 必须等于当前 HEAD；`diff_digest` 必须等于 Keel 重新计算的 baseline..HEAD diff；open finding 只能进入 rework |
| `land` | `land.commit` 必须等于当前 HEAD；branch 必须是 `ai/*` 且不等于 base；只登记 `push_and_pr` intent/outbox，不执行 push/PR |

review 的 diff 摘要由 Control 运行 `git diff --binary baseline..HEAD` 计算；模型自报的
旧 SHA、旧 diff 或旧 verify 证据都会被拒绝。review 提出 open finding 时任务回到
`execute`，保留 findings 作为下一轮上下文；最多三轮 rework。

被 workflow 节点绑定的 ticket 还会在 execute 后检查 `baseline..HEAD` 的实际改动文件：
每个路径必须落在节点 `scope_paths` 内，否则阶段失败为 `SCOPE_VIOLATION`。

verify 的 command/result 是隔离执行器产出的结构化证据，并由 Keel 用真实 git HEAD、
工作树干净状态和 diff 摘要绑定；`output_digest` 由 Keel 从 `output_excerpt` 重新
计算，不信任模型自报摘要。它不是模型自报的 `completed` 文本。当前切片不重放任意
项目测试命令；真实端到端模型验收属于 JT-02F。

## 5. 工具与隔离

阶段工具来自固定包的 `tool_policy`：

- `execute → developer`
- `verify → verifier`
- `review → reviewer`
- `land → releaser`

Keel 用当前 harness 的 `tool_inventory` 解析原生工具，只把解析结果放进
`permissions.allowed_tools`，模式固定 `deny_unlisted`。profile、harness 映射或必需能力
缺失时任务进入 `PAUSED`，不会静默降级或按品牌猜测工具名。

工作区标识为 `untrusted=true`，遵守 Adapter 的 `CAP-UNTRUSTED_WORKSPACE` 契约；
JT-02A 的环境 allowlist、macOS 操作系统沙箱、容器规格门禁和 agent 级凭据负例仍是
启动边界。managed 写执行在 macOS 上必须经过 `sandbox-exec` 文件系统/网络/
keychain 沙箱；没有等价沙箱的平台在启动期拒绝，不回退到宿主权限。GitHub 写凭据
不进入执行器。

## 6. must-stop、未授权动作与天问决策

任一阶段输出 `status=must_stop`、`status=blocked` 或 `requested_action` 时，阶段行
标记 `MUST_STOP`，并在一个 `keel_control` 事务中创建统一
`managed_decision_request`，绑定 `managed_ticket_task_id`、package digest、attempt
与 input digest。

- `must_stop` 或 `requested_action`：任务直接进入 `WAITING_HUMAN`，选项固定为
  “停止并等待人工处理（推荐）”与“批准本次继续（仅一次）”；即使配置了天问 runner
  也不会自动处理。
- `blocked` 且带 `decision`：保留模型提出的选项，追加一个“停止并等待人工处理”
  选项；请求初始为 `PROCESSING`。worker 用与阶段相同的 harness/model 运行天问，
  产出 `TianwenProposal` 并交给确定性接纳器。只有 E3 项目决定或 E1 可逆委托默认
  支撑的 `delegated` 才把任务放回 `READY`；`owner_required`、`denied`、模型超时或
  协议错误都会升级为 `WAITING_HUMAN`，不会自动继续。

本机操作员可用 `managed ticket-answer <request-id> --revision N --option ...` 答复。
如果该 revision 已有 `owner_required` 等决议，store 会创建 `revision + 1`、把旧
revision 标为 `SUPERSEDED`，再写入 `human_confirmed` 决议。`must_stop` 请求仍按
`option-2` 才继续；模型决策请求选择非“停止并等待人工处理”的选项即继续。人工
决议与天问提案都写入现有 `managed_decision_resolution` 台账。

## 7. CLI

```bash
pnpm keel managed ticket-create --repo <repo-uuid> --package <json> --worktree <path>
pnpm keel managed ticket-status <task-uuid>
pnpm keel managed ticket-stages <task-uuid>
pnpm keel managed ticket-tick --harness pi
pnpm keel managed ticket-worker --once --harness pi
pnpm keel managed ticket-answer <request-uuid> --revision 1 --option option-2
pnpm keel managed ticket-tianwen <request-uuid> --revision 1 --harness pi --model <id>
pnpm keel managed workflow-create --repo <repo-uuid> --package <route.json> \
  --worktree-root <dir> --scope src,docs --request '...'
pnpm keel managed workflow-plan --workflow <workflow-uuid> --plan <plan.json>
pnpm keel managed workflow-status <workflow-uuid>
pnpm keel managed workflow-list
pnpm keel managed workflow-retry --workflow <workflow-uuid> [--node <node-key>]
pnpm keel managed workflow-tick --harness pi --model <id>
pnpm keel managed workflow-worker --harness pi --model <id>
```

## 8. 未完成

- push / PR 属 JT-02D；required checks 与 `pr_ready` 属 JT-02E；
- archive、多 ticket 图与证据复用属 JT-04，见
  [workflow-routing.md](./workflow-routing.md)；项目记忆增量检索属 JT-03；
- 真实模型端到端验收属 JT-02F；
- 自动 merge / 部署仍不在本路径内；`PR_READY` 不等于已合并。

验证：`ticket-protocol.test.ts` 覆盖摘要与来源完整性；`ticket-runtime.test.ts`
覆盖正常四阶段、verify 缺证据、review 旧证据、must-stop 决策、天问按项目决定
解决偏好问题、天问不可用时升级人工、人工 revision+1 覆盖、升级隔离、协议不兼容、
tool profile 缺失与工作树绑定。
