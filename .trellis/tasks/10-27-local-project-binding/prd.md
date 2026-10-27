# 本地项目绑定与同步基线

## Goal

让 Keel 长期维护一个**本地项目**，而不是每个 task 从零全量克隆：

1. 注册项目时指定本地项目文件夹；
2. 每次开工前从远端增量同步基线；
3. 结束时照常 push 分支、创建 PR。

一句话：**项目是长期的，worktree 是一次性的。**

## Background & Confirmed Facts

| 事实 | 证据 |
|---|---|
| `repo` 只有远程身份，没有本地路径 | `repo(id, provider, remote_url, default_branch, credential_ref, created_at)`，[migrations/1000000000000_initial-schema.sql](../../../migrations/1000000000000_initial-schema.sql) |
| 每次 run 在系统临时目录全量克隆 | `run-task` 使用 `mkdtempSync(tmpdir(), 'keel-cli-')`；`run-issue` 复用同一驱动 |
| 没有增量同步 | `ensureBareRepo` 发现裸仓库已存在即返回；仓库内无 `fetch` 调用 |
| worktree 基线取本地分支 | `ensureWorktree` 使用本地 `baseBranch` ref，不是 `origin/<base>` |
| 注册命令只收远程 URL | `keel register-repo <remoteUrl>`，无本地目录参数 |
| PR / CI 链路完整 | push `ai/*` → `PullRequestGateway` → 真实 CI 回读 |
| 临时目录未显式清理 | `run-task` 只有 `mkdtempSync`，没有对应 `rmSync` |

结论：**收尾链路完整，开工链路缺失。** 当前「拿到最新代码」是靠每次重新全量克隆换来的，
不是「长期项目 + 增量同步」；也没有任何本地项目文件夹的绑定关系。

## Requirements

### R1 本地项目绑定

- **R1.1** `repo` 可绑定一个本地项目文件夹（`local_path`），可为空。
- **R1.2** 提供注册/绑定命令：同时指定 remote URL 与本地目录；同一 remote 幂等。
- **R1.3** 绑定时校验三件事：目录存在、是 git 工作树、`origin` 与注册的 remote 归一化后一致。
  任一不满足即拒绝，零写入。
- **R1.4** `local_path` 为空时保持「Keel 托管」模式：由 Keel 在项目根下维护仓库副本。
- **R1.5** 同一实例内，一个 repo 只能绑定一个 `local_path`；同一 `local_path` 不能绑定多个 repo。
  路径在比较与写库前必须归一为**绝对 `realpath`**：尾斜杠、`.`/`..`、重复分隔符、
  相对路径与符号链接都视为同一目录。
- **R1.6** 已注册 repo 可更新绑定：不传新路径时保留原值；传新路径时先完整校验再原子更新；
  新路径已被其他 repo 占用时拒绝，错误中同时给出两个 repoId。

### R2 持久项目根

- **R2.1** 本地项目根默认 `.keel`，可通过环境变量覆盖；相对值按进程启动时的 cwd
  解析为绝对路径并固化，后续不随 cwd 变化。
- **R2.2** 不再使用系统临时目录作为项目根；进程重启后项目仍在。
- **R2.3** 每个 task 仍有独立 worktree；终态清理 / 保留现场规则不变。
- **R2.4** 绑定模式（attached / managed）对 task 状态机与上层调用透明。

### R3 开工前同步

- **R3.1** 每次 run 前从远端 fetch 基线分支（`--prune`）。
- **R3.2** 新 worktree 必须从 `origin/<base>` 创建，不能从本地 `<base>` 创建。
- **R3.3** 记录本次基线：`base_ref`、`base_sha`、`fetched_at`，可从事件流或 `keel status` 查到。
- **R3.4** 同步失败时 fail-closed：不创建 run、不推进 task 状态，错误信息包含可执行的下一步。
  每类失败有稳定的错误码前缀（目录缺失、origin 不匹配、鉴权失败、base 不存在、锁超时等），
  便于测试与用户按码排查。
- **R3.5** 同步不得修改用户工作树：不 `pull`、不 `checkout`、不 `reset`、不 stash，只做只读 `fetch`。
- **R3.6** 本地工作树脏或与远端分叉时如实报告；基线始终取 fetch 后的 `origin/<base>`，
  不自动修复、不偷偷改用本地提交。

### R4 兼容、安全与可观测

- **R4.1** 不改变 task 状态机、三平面边界、数据库授权矩阵。
- **R4.2** 不改变 PR / CI 链路与 `ai/*` 分支命名。
- **R4.3** worktree 隔离与 untrusted workspace 约束不降级。
- **R4.4** `keel status` 至少显示：绑定模式、`local_path`、`base_ref`、`base_sha`。
- **R4.5** 现有 `register-repo` 调用、测试与 e2e 流程保持可用。
- **R4.6** 共享 git 状态并发安全：同一 repo 的首次 clone、fetch、同 task worktree 创建
  在并发调用下必须串行且幂等；不得产生半成品仓库或 `index.lock` 冲突。
- **R4.7** 顶层 CLI 帮助与实际参数一致：`keel` 与 `keel register-repo --help`
  都列出 `--local-path`。

## Non-Goals

- 不引入新的 `project` 实体；v0.1 用 `repo` 承载项目。
- 不做多项目 / 多租户 / 一个 repo 多项目。
- 不做自动 rebase、自动解决冲突、自动 pull 用户分支。
- 不做长期驻留的 worktree 或热重载。
- 不把控制台重构成项目导向；最多增加过滤维度。
- 不扩展 GitLab / local provider 的同步语义。
- 不改凭据管理方式。

## Acceptance Criteria

- [ ] **AC1** 绑定成功：`--local-path` 指向合法 git 工作树且 origin 匹配 → 返回 repoId，DB 中 `local_path` 已写入。
- [ ] **AC2** 绑定失败：目录不存在 / 非 git 仓库 / origin 不匹配 → 非 0 退出、明确错误、零 DB 写入。
- [ ] **AC3** 持久根：连续两次 run 不重复全量克隆；第二次直接复用本地项目副本。
- [ ] **AC4** 基线正确：远端 base 前进后，新 worktree 的起点是新的 `origin/<base>`，事件中的 `base_sha` 与远端一致。
- [ ] **AC5** 不碰用户工作树：run 前后用户的当前分支、HEAD、未提交改动内容不变。
- [ ] **AC6** fail-closed：远端不可达 / 鉴权失败 / base 分支不存在 → run 不创建、task 状态不变、错误含可执行下一步。
- [ ] **AC7** 幂等：同一 task 重复 run 复用已有 worktree 与分支，不重复建分支、不改基线。
- [ ] **AC8** 回归：现有真实 Issue → PR → CI 的 e2e 仍通过。
- [ ] **AC9** `pnpm run check` 全绿。
- [ ] **AC10** `keel status <id>` 能看到绑定与基线信息。
- [ ] **AC11** 路径归一：`<dir>`、`<dir>/`、`<dir>/./`、相对路径、指向 `<dir>` 的符号链接
  写库后是同一个绝对 `realpath`；用别名二次绑定被拒绝。
- [ ] **AC12** 并发安全：并发调用首次 prepare / fetch / 同 task worktree 创建时，
  clone 只发生一次、worktree 只创建一个，无半成品目录与 `index.lock` 冲突；
  锁超时返回固定错误码且零写入。
- [ ] **AC13** 绑定更新：无 flag 保留原值；managed → attached 成功；校验失败时原值不变；
  同一路径被占用时错误包含两个 repoId。
- [ ] **AC14** orchestrator 接线：经 `loop.ts` 的 `resolveWorkspace` 与 `headSha`
  走新 API；真实 CI 读到的 head SHA 与 worktree 一致，`base_sha` 证据完整。

## Open Questions

已决（见 `implement.md` Step 0）：

| 问题 | 结论 |
|---|---|
| 1. 命令形态 | 扩展 `register-repo --local-path` |
| 2. attached 对象库 | 直接使用用户仓库，worktree 仍在 `.keel` 下 |
| 3. 本地未推送提交 | 忽略，基线始终 `origin/<base>`，`status` 报 `diverged` |
| 5. 离线模式 | 不提供，同步失败即 fail-closed |

仍开放：

4. ssh 与 https 形式的同一 remote 是否视为等价？
6. 控制台展示放在本任务还是后续任务？
7. `remote_url` 无唯一索引，同一 remote 并发注册可能产生重复行——既有问题，
   本任务不顺手加索引（存量重复会让迁移失败），后续单独任务处理。

## Out of Scope

- 控制台 UI 改造（除 `keel status` 文本）
- 多 repo 路由、项目切换器
- 凭据管理改造
- CI / PR 行为变更
