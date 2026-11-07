# 补齐存量 S-HUMAN_REVIEW 的人工裁决 TTL

## Goal

修复 issue #75：`human_review_ttl` 上线前就已停在 `S-HUMAN_REVIEW` 的任务，
升级后永远不会被武装 TTL，`T-028` 的到期弃单对它们不生效。

目标状态：只要 `timer-worker` 在 TTL 开启的配置下跑过一轮，
所有 `S-HUMAN_REVIEW` 任务都有一条 pending 的 `human_review_ttl`；
且这个纠偏是幂等的、不会重置已经武装过的期限。

## Background

- `human_review_ttl` 由 0009 迁移引入（`migrations/1000000000009_human_review_ttl.sql`），
  只扩 `timer.kind` 的取值域。
- 武装发生在**进入** `S-HUMAN_REVIEW` 的转移 effects 里（T-013 / T-020 / T-023 / T-026 / T-031），
  离开时取消（T-014 / T-015 / T-016），到期由 T-028 收割。
- 升级前已在该状态的任务没有进门转移可走，因此没有任何 `human_review_ttl` 行。
  实测：8 个任务、26 次进门记录，`timer` 表只剩 `wall_clock/cancelled`。
- `poller` 只扫描与调度，不负责到期收割；TTL 的武装/收割责任在 `timer-worker`。

## Requirements

- **R1** `timer-worker` 在每轮 drain 的收割之前，对账并补齐缺失的
  `human_review_ttl`：`task.status = 'S-HUMAN_REVIEW'`、`control_mode = 'auto'`、
  且不存在 pending 的 `human_review_ttl` 行。
- **R2** 补齐行的 `due_at = 本轮 drain 的注入 now + 当前生效 TTL`。
  生效 TTL 与 `StartTimer` 同源：`undefined` → 默认 24h；正整数 → 该小时数；
  `null`（`KEEL_HUMAN_REVIEW_TTL_H=0`）→ **不补齐**。
- **R3** 幂等：已有 pending 行时不得改动其 `due_at`；重复 drain 不重复插入。
- **R4** 与离开/进入 `S-HUMAN_REVIEW` 的转移串行：补齐时先锁 `task` 行，
  避免在批准/驳回/回炉提交后留下一条 pending 行，
  挡住下一次进门转移的 `StartTimer`（`timer_pending_key` 会让它静默 `skipped`）。
- **R5** 可观测：`ReapStats` 增加 `humanReviewArmed`；`timer-worker` **单次 drain**
  的统计行输出该计数。常驻模式沿用现状——`runForever` 每轮不打印 stats，
  不为本次修复新增高频日志（需要常驻可观测时另立 follow-up）。
- **R6** 不新增数据库迁移，不改转移表，不改 T-028 语义，不自动批准。

## Acceptance Criteria

- [ ] 铺一个 `S-HUMAN_REVIEW`、无 timer 的任务；以 24h TTL drain →
      新增 1 条 pending `human_review_ttl`，`due_at = now + 24h`，
      `stats.humanReviewArmed = 1`。
- [ ] 同一任务连续 drain 两次 → 第二次 `humanReviewArmed = 0`，`due_at` 不变。
- [ ] TTL 关闭（`humanReviewTtlMs = null`）→ 不插行，`humanReviewArmed = 0`，
      不报错。
- [ ] 自定义 TTL（如 1h）→ `due_at = now + 1h`。
- [ ] 非 `S-HUMAN_REVIEW` 或 `control_mode != 'auto'` 的任务 → 不补。
- [ ] 已有 pending `human_review_ttl` 的任务 → 不改 `due_at`、不新增行。
- [ ] e2e：补齐后把 `due_at` 改到过去，再 drain → T-028 → `S-ABANDONED`，
      timer 置 `fired`。
- [ ] `pnpm run check` 全绿；反例：移除补齐调用后新增用例变红。

## Constraints

- 补齐是**兜底**，不是第二套进门逻辑：不改变 `StartTimer` / `CancelTimer` /
  `ConsumeTimer` 的语义，不改变转移表。
- 不在迁移里硬编码 24h：SQL 迁移读不到 `KEEL_HUMAN_REVIEW_TTL_H`，
  硬编码会同时破坏「0 = 关闭调度」与自定义 TTL。
- 编辑已应用的 0009 不会在已升级的库上重跑；新迁移也无法感知运行期配置。
  因此修复点放在唯一同时知道「生效 TTL」与「谁负责收割」的 `timer-worker`。
- 不碰 `clarification_ttl`、`wall_clock` 与其它状态的兜底。

## Out of Scope

- 为 `S-HUMAN_REVIEW` 之外的状态补齐任何 timer。
- 修改 `human_review_ttl` 的默认时长或 T-028 的弃单语义。
- 存量任务的历史待办 UI / 通知（控制台已有决策页，不在本任务范围）。
- issue #75 之外的 policy / auto_develop 放行带调整。

## Key Decisions

- **用运行期对账而不是迁移 backfill。** 理由见 design.md §2：
  已应用的 0009 不会重跑；纯 SQL 迁移读不到 `KEEL_HUMAN_REVIEW_TTL_H`，
  硬编码 24h 会在 TTL 关闭/自定义时产生错误行为。`timer-worker` 是唯一
  同时持有生效 TTL 与收割职责的进程，把「S-HUMAN_REVIEW ⇒ pending TTL」
  做成每轮可自愈的不变量，比一次性补数据更稳。
- **给存量任务一个完整 TTL 窗口**，从首次对账的 now 起算，而不是从进门时间起算；
  否则升级后立即到期，等于静默弃单。
- **只补 `control_mode = 'auto'`**：`paused` / `human` 下 T-028 不会转移，
  补了只会每轮被 claim 又跳过。
