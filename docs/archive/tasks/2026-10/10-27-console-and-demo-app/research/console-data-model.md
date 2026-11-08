# 研究 · 控制台可用的只读数据面

## 角色与授权（migrations/1000000000000_initial-schema.sql）

`keel_control` 的 SELECT 覆盖控制台需要的全部表：

- `repo`（remote_url / default_branch）
- `task`（status / control_mode / title / base_branch / work_branch / risk / complexity / timestamps）
- `run`（stage / attempt / status / harness_id / harness_tier / started_at / ended_at / error_*）
- `event`（seq / type / payload / run_id / occurred_at）
- `artifact`（kind / key / version / body / committed_at）
- `feedback`、`task_feedback`

写权限同理明确：`event` / `artifact` 对 `keel_control` 只有 INSERT；控制台不写即可。
**不需要新增迁移或角色。**

## 现有读取路径

- `src/fact/db.ts`：`asRole('keel_control', fn)`，`SET LOCAL ROLE` 在事务内生效。
- `src/fact/artifact-store.ts`：`readEvents(taskId, from, limit)` 按 `seq` 升序分页。
- `src/cli/status.ts`：直接用 `asOwner` + 原生 SQL 查 task / run / event —— 控制台沿用原生 SQL，
  但角色换成 `keel_control`（status 用 owner 是历史写法，不是控制台该模仿的）。

## 现状数据（2026-10-27）

`keel_dev`：7 tasks / 23 runs / 109 events / 4 repos。
最新完成的一条：`1d891a16-…` `demo4: README Usage 小节`，`S-DONE`，
5 个 run（pm / rfc_draft / develop / qa / review），事件 81–109。

## 状态机渲染

`src/control/transition/table.ts` 导出 `TASK_TRANSITIONS`（纯数据）。
页面用它渲染状态与出边；主路径按 docs/04-state-machine.md §1 的顺序：

`S-NEW → S-PM_ANALYZING → S-BRAINSTORM → S-RFC_DRAFT → S-RFC_READY → S-DEVELOPING → S-QA → S-REVIEW → S-PR_OPEN → S-DONE`

旁路：`S-NEED_CLARIFICATION`、`S-HUMAN_REVIEW`、`S-REJECTED`、`S-ABANDONED`、`S-FAILED`。

## 页面约束

- 单文件 HTML，原生 JS；无构建、无 CDN、无新依赖。
- 只绑定 127.0.0.1。
- 自动刷新只轮询 `/api/tasks/:id`。
