# Round 2 P1 修复 — 执行计划

## 批次与顺序

### 批次 1 — R2(occurred_at 统一,独立小改)

1. `effects.ts`:
   - `emit(c, taskId, type, payload, occurredAt)` 加 occurred_at 列;
   - 全部调用点传 `ctx.now`。
2. `pipeline.ts`:
   - `runSessionUntilValid` opts 加 `now: string`(必传);
   - ProposalAccepted/Rejected 的 INSERT 加 occurred_at = opts.now;
   - 更新调用点:loop.ts(传 deps.now())、session-pipeline.test.ts、session-milestone.acceptance.test.ts。
3. 回归:
   - `session-pipeline.test.ts`:事件 occurred_at == 注入值;
   - 全量 `pnpm run check`。
4. commit footer `(issue #23 R2)`。

### 批次 2 — R1 失败面(核心)

1. `loop.ts` 阶段态分支:executeRun 失败 → 标 run 状态 + emit 失败事件 + driver.advance(T-030/T-031)+ continue(不再 return err)。
2. RunCancelled 分支:标 CANCELLED,不 emit,continue(loop 自然停)。
3. 新增 helper:`failRun()`(UPDATE run SET status/ended_at/error)、失败映射。
4. 回归 e2e `src/control/orchestrator/run-failure.test.ts`:
   - 用例 A:fake adapter 第 1 次产非法提案(连续 3 次 → R-006)→ RunFailed → T-030 → 重试 run(attempt=2)成功 → 终态。断言:run 不卡 PENDING、重试 key 以 /2 结尾、事件流含 RunFailed。
   - 用例 B:fake adapter 连续产非法提案到 attempt=3 → T-031 → S-HUMAN_REVIEW。断言:停在人工、NotifyHuman effect 落事件。
   - 用例 C:adapter 返回 CANCELLED → run 标 CANCELLED,不重试,loop 停。断言:无新 run、run.status=CANCELLED。
5. 全量 `pnpm run check`。
6. commit footer `(issue #23 R1)`。

### 批次 3 — 文档 + 全量验证 + 收尾

1. `docs/07-flows.md` 或 `04-state-machine.md`:确认失败流转描述与实现一致(若无差异不改)。
2. `pnpm run check` 全绿(含新 e2e)。
3. 关闭 issue #23(R1、R2 勾选);留 comment 说明 P2 项未动(另开)。
4. 归档任务;gbrain state 更新。

## 验证命令

```bash
pnpm run check
# lint → typecheck → boundaries → check:generated → check:transitions → check:purity → test
```

## 评审门

- 批次 2 前:确认 RunCancelled「标 CANCELLED 不 emit 事件」语义(与 T-040 外部取消路径的关系——本任务不自动发 Task 级 Cancelled)。
- pipeline opts.now 必传的破坏面:3 个调用点,检查测试桩是否全更新。
- T-030 的重试是**同步立即**重试(无延迟),与「重试自环」文档语义的差异需在 commit 说明。

## 回滚

- 每批独立 commit;回滚 = revert 单 commit。
- R1 若破坏同步循环:回退 loop 分支到 `return err`(放弃重试,回到现状);T-030/T-031 声明实现完整重试时另做。

## 验收核对

| R | 交付 | 验证 |
|---|---|---|
| R1a 失败标状态 | loop.ts failRun + 事件 | run-failure.test 用例 A/B/C |
| R1b T-030/T-031 走通 | driver.advance 失败事件 | 用例 A(重试)/ B(升人工) |
| R1c CANCELLED 不重试 | 标 CANCELLED continue | 用例 C |
| R2a emit 注入 occurred_at | effects/pipeline | session-pipeline 回归 |
| R2b 时间 == 注入 now | 事件读回比对 | session-pipeline 断言 |