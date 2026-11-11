# 受控 action outbox 与 PR 网关

> 范围：JT-02D。ticket 的 `land` 阶段只登记外部动作意图；独立的 action gateway
> 重验当前授权与证据后签发 `ExecutionPermit`，再由它执行 push 和创建 PR。
> 本切片不消费 required checks，也不声称到达 `pr_ready`。

## 1. 事实来源与边界

`land` 阶段成功后，`managed_ticket_runtime` 在同一个 `keel_control` 事务里写入：

- `managed_action_intent`：动作参数、准确 head SHA、diff 摘要、目标分支、PR 标题/正文；
- `managed_action_outbox`：状态为 `PENDING` 的持久待办；
- `managed_ticket_task.status = WAITING_GATEWAY`。

执行器和 Harness 不持有 GitHub 写凭据，也不执行 `git push`、PR API 或 legacy
发布 CLI。只有 `keel managed action-gateway` 进程读取 outbox，签发许可并执行外部动作。

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
- 准确 `expected_sha`、`diff_digest` 与完整目标摘要 `target_digest`；
- 环境、单调递增的 `fencing_token`、幂等键、签发/过期时间。

签发许可前，gateway 用 `FOR SHARE` 语义锁定授权策略并重新校验其项目、版本、
有效期、撤销/替代状态。旧 worker 或旧 fence 无法写入成功结果；过期许可不能
开始新动作。

## 4. 授权

gateway 读取项目内当前有效的 `managed_delegation_policy`，只接受同时满足以下条件的规则：

- `actions` 覆盖 `push_and_pr`；
- 环境、可逆性与资源选择器匹配；
- `impact_limits` 覆盖资源数量；
- 规则模式为 `delegated`，且没有本切片尚未执行的 evidence/check/预算要求。

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
4. 成功后 outbox `SUCCEEDED`、permit `CONSUMED`、task `PR_OPENED`，handoff 记录 PR。

push 或 PR 结果不确定时：

- outbox 进入 `UNCERTAIN`，task `PAUSED`；
- `action-reconcile` 先查远端分支：不存在则确认无副作用并安全重排；同一 SHA
  则复用/创建 PR；不同 SHA 则失败；
- 不盲目重放 push，也不把数据库提交当成 GitHub exactly-once。

## 6. 凭据

- GitHub API token 只存在于 gateway 进程；复用 `resolveGitHubToken` 的来源优先级。
- git HTTP 认证只为单次子进程注入 `GIT_CONFIG_*`，token 不进 URL、不进 argv、
  不进事件 payload 或错误文本；错误输出经 `redactSecrets` 脱敏。
- Harness 的凭据负例与容器边界继续由 JT-02A 的 `check:agents` / `check:isolation` 证明。

## 7. CLI

```bash
pnpm keel managed action-list --task <task-uuid>
pnpm keel managed action-gateway --once
pnpm keel managed action-gateway --interval 5000 --reconcile
pnpm keel managed action-reconcile --id <outbox-uuid>
pnpm keel managed action-retry <outbox-uuid>
```

`action-retry` 只允许对 `BLOCKED` / `FAILED` 使用；`UNCERTAIN` 必须先回查。

## 8. 未完成

- required check 语义、PR head SHA / 必需 check 证据链属 JT-02E；
- 真实单 ticket 端到端验收属 JT-02F；
- 本切片不自动 merge、不部署、不申请新凭据。
