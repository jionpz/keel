# jstack 路线图与多 ticket 工作流

> 范围：JT-04。jstack 负责判断 XS/S/M/L/XL、拆分 ticket 并给出依赖图；
> Keel 只做确定性校验、节点调度、阶段执行与证据归档。Keel 不自行重新规划，
> 也不把旧 `legacy-v01` 任务迁入新表。

## 1. 两层固定包

### 1.1 route 包

`jstack managed-export --route` 产出 `JstackRoutePackage`：

- `route_rules`：五档规模与 ticket 数量范围；
- `stage_templates`：四个固定阶段及 provider、gate、tool profile；
- `instructions`：route、stages、plan、must-stop 全文；
- `tool_policy`、`must_stop`、`archive_gate`；
- `sources`：所有来源路径、SHA256、字节数；
- `content_digest`：排除本字段后的 canonical JSON SHA256。

五档规则：

| 规模 | ticket 数 | 单 ticket 规模 |
|---|---:|---|
| XS | 1 | XS |
| S | 1 | S |
| M | 1–3 | 不超过 M |
| L | 2–12 | XS/S/M |
| XL | 2–20 | XS/S/M |

所有 managed ticket 固定 `execute → verify → review → land`。XS/S 也强制 review，
这是后台写路径的安全覆盖，不声称与交互式 jstack 路线完全相同。

### 1.2 ticket 包

节点物化时，Keel 从固定 route 包与节点定义生成 `JstackTicketPackage`。
ticket id、标题、阶段模板与 provider 均来自 route 包；节点额外保存
`depends_on`、`scope_paths`、`acceptance`。ticket 包摘要写入
`managed_ticket_task.package_digest`，任务运行期不再读 jstack 工作区。

## 2. 计划校验

`commitManagedWorkflowPlan` 在提交图之前拒绝：

- route 规模缺失或 ticket 数不在对应范围；
- XS/S ticket 规模不一致，或 ticket 大于整体路线；
- 重复 key、ticket id、external issue；
- 自依赖、依赖不存在、循环依赖、没有根节点；
- scope path 非相对规范路径，或越出 workflow `scope_paths`；
- route 包/来源/阶段模板摘要被篡改；
- ticket 引用的 provider profile 不在固定 tool policy 中；
- issue 已被 `legacy-v01` 或另一个 managed 所有者占用。

通过校验的计划写入 `managed_workflow_graph`，计划正文与摘要不可变；
图版本递增。只有节点尚未物化、尚未执行时才能显式 `replan`，旧版本标记
`SUPERSEDED`，已绑定任务不跟随新图。

## 3. 节点与调度

工作流状态：

```
ROUTING → READY → RUNNING → WAITING_HUMAN / WAITING_GATEWAY → READY → DONE
                         ↘ PAUSED / FAILED / CANCELLED
```

节点状态：

```
PENDING → READY → RUNNING → WAITING_HUMAN / WAITING_GATEWAY
        → PR_READY → ARCHIVED
        ↘ FAILED / CANCELLED
```

`tickManagedWorkflow` 每次只做一个确定性动作：

1. 无图时调用 jstack planner，校验并提交图；
2. 图已存在时物化一个依赖已满足的 `PENDING` 节点；
3. 否则推进一个 `READY` 节点的一个阶段；
4. 同步节点状态、尝试 archive、重算工作流状态。完整状态与优先级见
   [managed 状态机](../../managed-state-machine.md)；同步在选取节点前也执行一次，
   避免使用旧 `WAITING_HUMAN` / `PR_READY` 调度。

独立节点只等待自己的依赖闭包。一个节点进入 `WAITING_HUMAN` 不会阻塞无依赖关系的
根节点；依赖它的节点仍保持 `PENDING`。

依赖只有到 `ARCHIVED` 才满足，不能绕过完成门就启动下游。多个依赖提交必须位于同一条历史线上，Keel 用 `git merge-base --is-ancestor`
选出确定的覆盖 commit 作为下游基线；分叉历史直接拒绝，不做隐式合并。

## 4. scope 与工作树

每个节点有独立 Git 副本，分支名 `ai/wf-<workflow8>-<node-key>`，基线来自
workflow baseline 或已归档依赖节点输出 commit。根节点从注册源仓库复制，
下游从覆盖全部依赖的前驱私有仓库复制，不向宿主写回 refs 或对象。
Control Plane 使用 `clone --no-local --no-checkout`，不借用源对象库或硬链接；
旧 linked worktree 拒绝执行并保留原现场。数据库 `worktree_path` 与 CLI
`--worktree-root` 沿用名称，仅表示存储路径。工作树必须干净，HEAD 必须等于绑定输入；
有证据的超时恢复例外见 [ticket-execution.md](./ticket-execution.md)。

`execute` 成功后，Keel 用 `git diff --name-only baseline..HEAD` 重新计算改动文件；
每个路径必须落在节点 `scope_paths` 的某个前缀下。越界改动使阶段失败，
任务暂停为 `SCOPE_VIOLATION`，不会把越权提交带入 verify/review/land。

阶段执行器不 push、不创建 PR。`pr_ready` 目标的 `land` 只登记 `push_and_pr`
action intent，外部副作用仍由 action gateway 与 check gateway 承担；
`branch_ready` 目标的 `land` 只写 branch/commit handoff，不创建 action intent
或 outbox，ticket 直接进入 `DONE`。

## 5. 证据与复用

每个成功阶段写一条 `managed_workflow_evidence`：

- workflow、graph version、node；
- stage、input commit、diff digest；
- stage/gate digest、branch；
- target digest、result digest、evidence digest。

target digest 绑定 stage、节点 ticket id、scope、acceptance、输入 commit、diff 与
branch。`verify` / `review` 若找到同 workflow、同 stage、同 target 的 `VALID` 证据，
可把阶段标为 `REUSED` 并引用来源 evidence id；不会重复调用模型。

review 要求 rework 或 verify 的 check 未通过时，该节点的 verify/review/land 证据
失效；重新 execute 产生新 commit 后 target 改变，旧证据不能复活。未通过的 verify
不写入证据，同一提交上再次 verify 必须真实重跑。execute 经恢复决定确认原提交时，该节点
同一提交上旧的 execute 证据失效，由这次确认的证据取代。缺 gate、旧 SHA、旧 diff、伪造摘要均被拒绝。

## 6. 取消与静止边界

`managed workflow-cancel --workflow <workflow-uuid> --graph-version <N> --reason '...'`
只能取消命令指定的准确图版本。版本必须等于 workflow 当前图版本（未提交图时为 0）；
缺失、过期或不匹配时返回冲突且不写入任何取消副作用。

取消只在静止边界提交，并在同一事务中先锁定、复核再写入。workflow 或任一 ticket
仍为 `RUNNING`，或任一未归档节点关联的 outbox 仍为 `EXECUTING`、`UNCERTAIN`、
`SUCCEEDED` 时，整体拒绝取消；这些事实必须先结算、回查或归档。通过检查后：

- workflow 置为 `CANCELLED`，清除 workflow lease；
- 非终态 ticket 与待答 decision 置为 `CANCELLED`，ticket 递增
  `control_generation` 并清除 lease；
- 本流程的 `PENDING` / `LEASED` outbox 置为 `BLOCKED`，`VALID` permit 置为
  `REVOKED`；
- `ARCHIVED` 节点及其 claim 保持原样，`FAILED` 节点与 `DONE` / `FAILED` /
  `CANCELLED` ticket 保留原状态；其余未归档节点置为 `CANCELLED`，释放本流程持有
  且不属于归档节点的 `ACTIVE` claim，允许新 workflow 认领。

所有历史 stage、graph、evidence、worktree 与 claim 记录都保留，取消不删除或改写
历史事实。成功取消的同一 `workflow_id + graph_version` 可幂等重试：再次返回成功，
不重复递增代次，也不释放已转交给新 owner 的 claim。`CANCELLED` workflow 是终态，
`workflow-retry` 必须拒绝。

新基线或新固定包必须创建新 workflow。已执行的图不能 `replan`，旧 workflow 的
stage/evidence 也不能跨 workflow 冒充新图通过。

## 7. archive

`archive` 是工作流完成门，不是远程 Issue 自动关闭器。归档要求：

- `pr_ready` 目标下 ticket 已到 `PR_READY`，或 `branch_ready` 目标下已到 `DONE`；
- execute、verify、review、land 的最新尝试成功或复用，输出 head、包、门禁摘要与当前
  `VALID` workflow 证据匹配；
- handoff 提供准确 40 位 head SHA，工作树仍干净，当前 HEAD 与 diff 均匹配 handoff；
- `pr_ready` 目标还要求当前远端 PR 与原绑定一致，且仍开放或已经合并。
  check gate 必须为 `READY`，与持久 check 观察绑定同一 head、分支和证据摘要。

归档写 `archive` 证据并记录 archive gate 摘要；成功后节点变 `ARCHIVED`，所有节点
归档后 workflow 变 `DONE`。归档失败写节点 `FAILED` 与持久错误；无其他可推进节点时
workflow 为 `PAUSED`，修复后用 `workflow-retry` 重新尝试完成门。`archive` 证据明确注明“远端 issue 的关闭仍需受控写入口”，
不把本地归档冒充远程关闭。

## 8. 两套投影

- legacy：`task / run / event`，`legacy-v01`；
- managed workflow：`managed_workflow*`，`jstack-managed-v1`。

CLI：

```bash
pnpm keel managed workflow-create --repo <uuid> --package <route.json> \
  --worktree-root <dir> --scope src,docs --request '...'
pnpm keel managed workflow-plan --workflow <uuid> --plan <plan.json>
pnpm keel managed workflow-status <uuid>
pnpm keel managed workflow-list
pnpm keel managed workflow-retry --workflow <uuid> [--node <node-key>]
pnpm keel managed workflow-cancel --workflow <workflow-uuid> --graph-version 2 \
  --reason '停止已到静止边界的工作流'
pnpm keel managed workflow-tick --harness pi --model <id>
pnpm keel managed workflow-worker --harness pi --model <id>
```

`workflow-retry` 只把失败节点恢复为 `READY`，保留原 attempt 预算与当前阶段；
ticket 已达到完成目标时只重试 archive，不改写已结束 ticket、不重新执行四阶段。
`ARCHIVED`、`CANCELLED` 与工作流终态不可回退。

控制台只读 API：

- `GET /api/tasks` → `projection: legacy-v01`
- `GET /api/workflows` → `projection: jstack-managed-v1`
- `GET /api/workflows/:id` → workflow、当前图、节点、证据

两套投影不共享状态机；旧 poller/driver 不认领 `managed_workflow`。

## 9. 未覆盖

- 真实 L 多 ticket 模型 E2E 已通过（Pi + `opencode-go/deepseek-v4.1-flash`，2 个
  依赖 ticket、两节点 archive、outbox 为空）；XL 复用同一路径，但未单独跑真实模型 E2E。
- archive 不自动关闭 GitHub Issue；远程关闭需要后续受控写入口。
- legacy intake 与 managed issue claim 共用事务 advisory lock 并双向检查所有权；
  两个引擎并发进入时只有一个成功。该边界在 Control 入口强制，不是数据库触发器，
  不允许新入口绕过 `WorkflowDriver.intake` / `claimIssue` 直接写所有权。
- 工作流图的真实重规划仍由 jstack planner 产出；Keel 不做语义重规划。
