# R-009 墙钟语义 · 执行清单

1. [x] 读五连 JSONL，统计 `failure_class=timeout` 次数
   → `archive/2026-08/08-29-five-run-campaign/research/five-run-results.jsonl`：
   5 行，`failure_class` 全为 `null`，**timeout = 0**
2. [x] 若 ≥2：起草 `docs/adr/0008-wall-clock-semantics.md`
   → 门槛未触发，但 ADR 仍按 R1 起草：`docs/adr/0008-wall-clock-semantics.md`（**Accepted**）
3. [x] 评审选项 A/B/C（见 design.md）
   → 选 **B**（预算归属上移到 Keel），理由见 design.md「实际决策」
4. [x] 若改代码：反例测试 + issue-e2e 或五连单跑对比
   → **本任务不改代码**：B 已于 2026-08-26 落地（`733103e` / `e471d11` / `ee52945` / `37bfb45`）。
   反例证据：`src/e2e/timer-inflight.test.ts`、`src/e2e/timer.test.ts`；
   端到端证据：五连 5/5 S-DONE，耗时 180–341s，全部在 `wallClockS: 600` 内收敛
5. [x] `pnpm run check` → PR
   → 纯文档变更（ADR + 索引 + 任务产物），无代码路径改动；
   归档提交见 git log（`docs(adr): 0008 墙钟语义`）

未触发时可归档为「ADR Proposed + 观察」，不阻塞父任务。
→ 实际归档为「ADR **Accepted** + 实现已在生产路径」，不阻塞父任务。
