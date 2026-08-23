# GitHub PR / CI 集成（v0.1 最后空缺）

> 父任务：`08-23-v01-closed-loop`

## Goal

把 `CreatePullRequest` 从 `SideEffectIntent` 变成**真实 GitHub PR**，
并把 `S-PR_OPEN` 等待的外部 CI 从“测试注入回调”变成**真实 CI 状态回读**。

这是 v0.1 判据“产出一个通过 CI 的 PR”的最后一块空缺。
需要先指定远程仓库和凭据；本任务在拿到之前先完成设计、接口与可本地验证的部分，
**不写假装做过的空实现**。

## Problem

当前状态：

| 项 | 现状 |
|---|---|
| `T-021`（创建 PR） | `applyEffects` 只记 `SideEffectIntent` |
| `S-PR_OPEN` 等待 CI | 编排器接收调用方注入的 `externalCi` 回调，测试里显式模拟 |
| 远程仓库 | `repo.remote_url` 支持 `github`，但尚无真实 push / PR 调用 |
| 凭据 | `repo.credential_ref` 字段已存在，尚无读取与注入路径 |

不解决的话，v0.1 判据里的“通过 CI 的 PR”仍然只是本地模拟。

## Requirements

### R1 · 真实 PR 副作用

- 注入 `GitHubProvider`（或等价接口）时，`CreatePullRequest` 必须真实执行：
  - 把该 Task 的 `ai/task-<short_id>` 分支 push 到远程；
  - 创建 PR（base = `repo.default_branch` / task.base_branch，head = work_branch）；
  - 在事件流中记录 `SideEffectApplied`，payload 含 `pr_url`、`pr_number`。
- 未注入 provider 时，继续记 `SideEffectIntent`，**不得静默跳过或假装成功**。

### R2 · 幂等

- 创建 PR 前先按 `head` 分支查已有 PR；
- 已存在则复用其编号，记 `SideEffectSkipped`，不重复创建。
- push 也须幂等：以 commit SHA 判断是否已推送，不重复推相同内容。

### R3 · 凭据安全

- 遵循 `docs/08-cross-cutting.md §1.3`：
  - `repo.credential_ref` 只存引用；
  - token 从进程环境（如 `KEEL_GITHUB_TOKEN`）或密钥管理注入；
  - 不写入 `artifact.body`、`event.payload`、日志、Context section。
- token 权限最小化：仅 `ai/*` 分支写权限 + PR 创建/读取 + CI 读取。

### R4 · 真实 CI 状态回读

- 在 `S-PR_OPEN` 使用真实 CI gateway 读取 GitHub Checks / Commit Status，
  返回 `passed` / `failed` / `pending`，由编排器转成 `CIPassed` / `CIFailed` 事件。
- CI 是外部事实源，不能由 Control Plane 自己“造活”。
- 保留本地/测试模式：无凭据时可注入 fake，但生产路径必须显式要求真实 gateway。

### R5 · 事件流保持诚实

| 情况 | 事件 |
|---|---|
| 真实 PR 创建成功 | `SideEffectApplied`（含 `pr_url` / `pr_number`） |
| 已存在 PR，复用 | `SideEffectSkipped` |
| 未注入 provider | `SideEffectIntent` |
| CI 查询结果 | 由编排器发 `CIPassed` / `CIFailed`，来源标注外部 |

### R6 · 不降低现有确定性

- 所有现有 `check` 断言保持。
- 新增的 GitHub 相关逻辑要有确定性单测（用 fake provider / 本地 git），
  不能只靠真实远程验证。

## Acceptance Criteria

- [ ] 真实 GitHub 场景：`CreatePullRequest` 创建 PR，事件流出现 `SideEffectApplied` 且含 PR URL/编号
- [ ] 重复调用同一 head 分支：复用已有 PR，事件流出现 `SideEffectSkipped`
- [ ] 未配置凭据/provider：仍记 `SideEffectIntent`，不报错也不假装成功
- [ ] `S-PR_OPEN` 能通过真实 GitHub Checks/Status 获得 `passed` / `failed`，驱动 `T-024` / `T-025`
- [ ] 事件与 artifact 中无明文 token / 凭据
- [ ] `pnpm run check` 全绿（在具备 OMP 可写 home 的正常环境）
- [ ] `pnpm run test:acceptance` 在提供远程仓库与凭据后可跑通“真实 PR + CI”路径
- [ ] 文档（README / docs）与实现状态一致

## Notes

- 本任务需要用户提供:远程仓库 URL、凭据方式(推荐 fine-grained PAT 或已登录 `gh`)。
- 在拿到凭据前,先完成接口、假实现、测试与文档;不把未验证的代码标成已完成。

## 进度(2026-08-23)

代码层完成:`GitWorkspace.push`、`GitHubProvider`(REST)、effects/orchestrator 接线、
单测 17+3 用例、`pnpm run check` 全绿(162 tests)。README 状态已同步。
剩余全部阻塞在**真实远程仓库与凭据**(Stage 4.4/5.3 单测与 6.x 验收除外):
提供 `KEEL_GITHUB_TOKEN` 与远程 URL 后即可跑真实验收路径。
