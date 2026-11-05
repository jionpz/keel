# 人工裁决超时自动收尾

## Goal

`S-HUMAN_REVIEW` 不再无限期阻塞：进入该状态时起 `human_review_ttl` 定时器，
到期自动走 `S-ABANDONED`；所有失败证据（事件流、分支、提交历史）完整保留。

## Background

- `S-HUMAN_REVIEW` 有 **5 条入边**：`T-013`（Policy 升级）、`T-020`（QA 重试耗尽）、
  `T-023`（评审重试耗尽）、`T-026`（CI 重试耗尽）、`T-031`（阶段重试耗尽）。
- **0 条超时出边**：人不在 `keel decide` 上出现，任务就永久停住。这不是"多一次决策"，
  是"多一次必须主动想起来去处理"。
- 同类问题已有解法：`S-NEED_CLARIFICATION` 挂 `clarification_ttl`，
  到期走 `T-008 → S-ABANDONED`。本次复用同一套机制，不新造定时器。

## Requirements

- **R1** 5 条进入 `S-HUMAN_REVIEW` 的转移都挂 `StartTimer(human_review_ttl)`。
- **R2** 新增转移 `T-028`：`S-HUMAN_REVIEW` + `TimerFired(human_review_ttl)` → `S-ABANDONED`，
  副作用 `ConsumeTimer(human_review_ttl)`（置 fired 与状态变更同一事务）。
- **R3** 3 条正常离开 `S-HUMAN_REVIEW` 的转移（`T-014` / `T-015` / `T-016`）都挂
  `CancelTimer(human_review_ttl)`。漏掉 `T-016` 会让 pending 行挡住回炉后再次进入时的
  `StartTimer`（`ON CONFLICT DO NOTHING`），静默失去 TTL。
- **R4** `T-040` / `T-041`（任一非终态 → 终态）取消两类 timer，终态不留 pending 行。
  这条同时修掉 `clarification_ttl` 既有的同类泄漏。
- **R5** TTL 默认 24 小时；`KEEL_HUMAN_REVIEW_TTL_H=0` 关闭调度（回到无限期等待）；
  非法值（负数 / 非数字）启动即报错，不静默回退默认值。
- **R6** `timer.kind` 的 CHECK 约束加入 `human_review_ttl`（迁移 `0009`）。
- **R7** `docs/04-state-machine.md` §2 转移表与 §6 定时器说明同步更新（C4 约束）。
- **R8** 收尾不删除任何证据：`S-ABANDONED` 是终态，`readEvents(task_id, 0)` 仍能重建全过程；
  分支与提交历史保留（与 `T-008` 一致）。

## Acceptance Criteria

- [ ] `T-013` / `T-020` / `T-023` / `T-026` / `T-031` 命中后，`timer` 表出现一条
      `kind='human_review_ttl'`、`state='pending'` 的行，`due_at = now + 24h`
- [ ] 到期后 `drainAllDueTimers` 能把任务推到 `S-ABANDONED`，那条 timer 变 `fired`
- [ ] `T-014` / `T-015` / `T-016` 命中后，同 task 的 pending `human_review_ttl` 变 `cancelled`
- [ ] `T-040` / `T-041` 命中后无残留 pending timer（两类都验）
- [ ] `KEEL_HUMAN_REVIEW_TTL_H=0` 时不插入 timer 行，任务仍停在 `S-HUMAN_REVIEW`（现状行为）
- [ ] `KEEL_HUMAN_REVIEW_TTL_H=abc` / `-1` 启动即报错
- [ ] `T-028` 在 `docs/04-state-machine.md` 与 `table.ts` 两侧一致，`check:transitions` 绿
- [ ] `pnpm run check` 通过

## Constraints

- 不新增状态；`S-HUMAN_REVIEW` 的语义不变，只是多了一条超时出边。
- 不自动 approve / 不自动 rework —— 超时只做「放弃并留证」，不做「替人做决定」。
- timer 仍是 Fact 平面的可变状态机（`pending → fired | cancelled`），不改成 append-only。

## Out of Scope

- per-task 覆盖 TTL（v1 只做进程级配置，不加 `task` 列）
- 通知渠道（邮件 / IM）接入
- `capability_request` 的默认 deny
