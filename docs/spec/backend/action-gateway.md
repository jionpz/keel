# 受控 action outbox、PR 与 required checks 网关

> 范围：JT-02D/02E。ticket 的 `land` 阶段只登记外部动作意图；独立的 action gateway
> 重验当前授权与证据后签发 `ExecutionPermit`，再由它执行 push 和创建 PR。
> 独立 check gateway 只读取准确 PR head SHA 上的 required checks，全部显式成功
> 后才把任务推进到 `PR_READY`。

## 1. 事实来源与边界

`land` 阶段成功后，`managed_ticket_runtime` 在同一个 `keel_control` 事务里写入：

- `managed_action_intent`：动作参数、准确 head SHA、diff 摘要、目标分支、PR 标题/正文；
- `managed_action_outbox`：状态为 `PENDING` 的持久待办；
- `managed_ticket_task.status = WAITING_GATEWAY`。

执行器和 Harness 不持有 GitHub 写凭据，也不执行 `git push`、PR API 或 legacy
发布 CLI。只有 `keel managed action-gateway` 进程读取 outbox，签发许可并执行外部动作。
check gateway 只做 GitHub 读操作，不接收模型或阶段结果里的“completed”自报。

## 2. 绑定与状态

`managed_action_intent` 不可变，一个 ticket 只允许一个 `push_and_pr` 动作。它固定：

- `project_id` / `repo_id` / `task_id`；
- `remote_url`、`base_branch`、`head_branch`（只允许 `ai/*`）；
- 完整 `head_sha` 与 `baseline..HEAD` 的 `diff_digest`；
- PR 标题/正文与幂等键。

`managed_action_outbox` 状态：

| 状态 | 含义 |
|---|---|
| `PENDING` | 等待 gateway 认领 |
| `LEASED` | 已认领，尚未开始外部动作 |
| `EXECUTING` | 已签发 permit 并开始外部动作 |
| `SUCCEEDED` | PR 已确认存在并记录 |
| `FAILED` | 确定失败（授权、分支冲突、认证等） |
| `BLOCKED` | 授权或当前事实不满足，未开始动作 |
| `UNCERTAIN` | 外部结果未知；必须先回查远端，禁止盲重试 |

租约过期时：`LEASED` 可安全重新认领；`EXECUTING` 自动转 `UNCERTAIN`，
并把 task 置为 `PAUSED`。`UNCERTAIN` 不参与普通认领。

## 3. ExecutionPermit

许可由 gateway 在 `keel_control` 事务中写入，绑定：

- `action_intent_id`、项目/repo、动作；
- 授权来源（当前仅 `delegation_policy`）的 id、版本、规则 id 与摘要；
- 签发时的项目授权 epoch（项目记忆 epoch）与任务 `control_generation`；
- 预算快照；当前只实现可验证的 `max_attempts`，按 outbox 已认领次数校验；
- 可选的决定绑定：request revision、resolution id 与决议 `context_digest`；
- 准确 `expected_sha`、`diff_digest` 与完整目标摘要 `target_digest`；
- 本次授权规则声明的 `required_checks` 快照；
- 环境、单调递增的 `fencing_token`、幂等键、签发/过期时间。

签发许可前，gateway 用 `FOR SHARE` 语义锁定授权策略并重新校验其项目、版本、
有效期、撤销/替代状态。实际动作开始前、`markActionExecuting`、permit 后以及 push
后创建 PR 前，都调用同一个 `managed_execution_permit_available()` 复核 permit、
策略、任务状态/控制代次、项目 epoch、决定 revision/决议与 authority refs。旧
worker、旧 fence、人工暂停/取消或授权撤销都会让许可失效；过期许可不能开始新动作。

## 4. 授权

gateway 读取项目内当前有效的 `managed_delegation_policy`，只接受同时满足以下条件的规则：

- `actions` 覆盖 `push_and_pr`；
- 环境、可逆性与资源选择器匹配；
- `impact_limits` 覆盖资源数量；
- 规则模式为 `delegated`；
- `required_evidence` 与预算上限仍属未实现门禁，命中时拒绝自动许可；
- `required_checks` 不再拒绝，而是固化进 permit，并由 check gateway 执行。

`max_cost_usd` / `max_tokens` 尚未实现可验证计量，命中即拒绝自动许可；
`max_attempts` 使用 outbox 的真实认领次数校验。不可逆/部分可逆的高影响动作必须
精确声明动作、环境与资源，任何包含 `*` 的 selector（包括 `foo*` 前缀通配）都不能
自动许可。

多个匹配 delegated 规则的 `required_checks` 取并集；任一匹配规则要求更严格模式时，
仍按 `deny` > `owner_required` > `delegated` 阻断。

多个匹配规则取最严格处置：`deny` > `owner_required` > `delegated`。撤销、替代、
过期或没有匹配规则时，outbox 进入 `BLOCKED`，task 进入 `PAUSED`，不执行任何外部写。

## 5. 执行与回查

开始动作前 gateway 重新检查：

- task 仍是 `WAITING_GATEWAY`；
- repo remote 与 base branch 未变化；
- worktree 干净、HEAD 与 intent 完全一致、branch 一致；
- 重新计算的 diff 摘要与 intent 一致；
- 授权在签发许可时仍有效。

然后依次执行：

1. `git ls-remote` 确认远端 `ai/*` 分支不存在或已指向同一 SHA；
2. `git push <sha>:refs/heads/<branch>`，绝不 force；
3. `GitHubProvider.createPullRequest`，按 head 分支幂等复用已有 PR；
4. 成功后 outbox `SUCCEEDED`、permit `CONSUMED`、task `PR_OPENED`，handoff 记录 PR；
   若人工已在执行期间暂停/取消，task 保持原控制状态，只记录
   `external_action_completed` 与 PR 事实，不自动恢复；
5. 同一事务创建 `managed_check_target`，绑定 intent、permit、repo/PR、准确
   `head_sha`、`diff_digest`、授权版本、`required_checks` 截止时间与 PR 编号。

push 或 PR 结果不确定时：

- outbox 进入 `UNCERTAIN`，task `PAUSED`；
- `action-reconcile` 先查远端分支：不存在则确认无副作用并安全重排；同一 SHA
  则复用/创建 PR；不同 SHA 则失败；
- 不盲目重放 push，也不把数据库提交当成 GitHub exactly-once。

### 5.1 人工暂停、取消、覆盖与权限撤销

`ticket-pause` / `ticket-cancel` 先锁任务与 outbox，把 `PENDING` / `LEASED`
动作立即置为 `BLOCKED`，撤销该任务所有 `VALID` permit，递增 `control_generation`，
并取消仍在等待的 decision request。已经 `EXECUTING` 的动作不会被谎报为已撤销；
系统写入 `ManagedActionControlBoundary`，要求回查远端或执行补偿。

`ticket-resume` 只接受 `PAUSED`，再次递增控制代次；旧 permit、旧 worker 和旧决定
都不能恢复执行。`ticket-override` 在任务继续前创建 `revision + 1` 的人工决议，并
先阻断未执行动作。`policy-revoke` 会暂停仍指向该策略且处于 `WAITING_GATEWAY` 的
任务，撤销其 `VALID` permit；policy 发布/撤销只接受本机 CLI 显式 owner 身份与
`--confirm`，并写审计事件。天问和执行 worker 没有 policy 写入口。

## 6. required checks 与 `PR_READY`

`managed_check_target` 一个动作只允许一条，初始 `PENDING`。check gateway 认领后：

1. 重新检查 task 仍在 check 阶段、repo/base 未变化、授权策略仍有效；
2. 重新检查 worktree 干净、HEAD/branch/diff 与 intent/permit 完全一致；
3. 通过 GitHub API 读取**该 PR 编号**的当前 head，再按该完整 SHA 读取 check-runs
   与 commit statuses；两次读取之间 PR head 变化则整次证据作废；
4. 每个 required check 只接受 `success`。`missing`、`pending`、`neutral`、
   `skipped`、`cancelled`、`timed_out`、`failure` 均不能完成；
5. 缺失或仍在运行的 check 保持 `CHECKING` 并持久化观察；到截止时间仍未全绿则
   `FAILED`；
6. 全部成功后 target `READY`、task `PR_READY`，handoff 写入 evidence digest。

每次观察写入 `managed_check_observation`，保存 repo、PR 号、实际 PR head SHA、
head/base branch、PR 状态、check 名称、事实源、结论、外部 id 与观察时间。
观察表 append-only；SHA-A 的绿色结论无法挂到 SHA-B，因为查询路径和证据行都绑定
实际 head SHA，控制层还会比较 intent/permit/worktree 的完整 SHA。

不调用 legacy `CiGateway.waitForCi()` 的“无人上报静默后视为通过”语义。required 列表
是策略事实；即使仓库没有配置 CI，只要策略要求了 check，缺失就会在超时后失败。

## 7. 凭据

- GitHub API token 只存在于 gateway 进程；复用 `resolveGitHubToken` 的来源优先级。
- git HTTP 认证只为单次子进程注入 `GIT_CONFIG_*`，token 不进 URL、不进 argv、
  不进事件 payload 或错误文本；错误输出经 `redactSecrets` 脱敏。
- Harness 的凭据负例与容器边界继续由 JT-02A 的 `check:agents` / `check:isolation` 证明。

## 8. CLI

```bash
pnpm keel managed action-list --task <task-uuid>
pnpm keel managed action-gateway --once
pnpm keel managed action-gateway --interval 5000 --reconcile
pnpm keel managed action-reconcile --id <outbox-uuid>
pnpm keel managed action-retry <outbox-uuid>
pnpm keel managed action-check-gateway --once
pnpm keel managed action-check-gateway --interval 10000
pnpm keel managed action-checks --task <task-uuid>
pnpm keel managed ticket-pause <task-uuid> --reason '...'
pnpm keel managed ticket-cancel <task-uuid> --reason '...'
pnpm keel managed ticket-resume <task-uuid>
pnpm keel managed ticket-override <request-uuid> --revision N --option OPTION --reason '...'
pnpm keel managed policy-list --project <repo-uuid>
pnpm keel managed policy-publish <policy.json> --owner <owner> --confirm
pnpm keel managed policy-revoke <policy-uuid> --owner <owner> --reason '...' --confirm
```

`action-retry` 只允许对 `BLOCKED` / `FAILED` 使用；`UNCERTAIN` 必须先回查。
`action-gateway --check-timeout-ms` 设置新 check target 的等待上限；
`action-checks` 输出 target 与全部观察历史，供审计和 02F 验收引用。

## 9. 未完成

- 真实单 ticket 端到端验收属 JT-02F；
- 自动 merge、部署与申请新凭据不在本路径内；`PR_READY` 不表示已合并。
