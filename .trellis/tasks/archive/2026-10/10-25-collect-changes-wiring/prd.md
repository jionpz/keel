# 把 collectChanges 接进编排：develop 后收真实 diff 并喂给 QA/Review

## Goal

让「这一轮到底改了什么文件」成为**系统观测到的事实**，而不是模型的自我声明：
`develop` 收尾时从工作区真读 git diff，落成事件；`qa` / `review` 从上下文里拿到这份
diff 再判断；声称实现了却什么都没改的 `develop` 不得以 `SUCCEEDED` 收场。

## 背景（问题证据）

`collectChanges()` 是 HarnessAdapter 契约里 `[v0.1 必须]` 的方法
（`docs/05-contracts/harness-adapter.md` §3.4），三个 Adapter 都实现了，
共享 `collectGitDiff`。但**编排层从来没调用过它** —— 全仓非测试引用只有
接口声明与三个实现本身。

后果（2026-10-25 真机跑通 `10-25-claude-auth-config` 时暴露）：

- `develop` 判 `SUCCEEDED` 的唯一依据是模型输出里那句 `"verdict":"implemented"`。
  模型什么都不改、只回一句 implemented，Run 照样成功。
- `qa` / `review` 的提示词是「检查工作区中的改动是否满足验收标准」
  （`prompts.ts` qa 分支），但它们的上下文配方是 `['role','rfc','state']`——
  **根本没有任何 diff 或改动清单**。它们只能对着 RFC 空想，或者去读整个工作区猜哪几个
  文件是这次动的。真机那一轮 QA/review 报「仅改了一个文件」，那是它猜的。
- `docs/07-flows.md` 第 20 步「收集工作区变更」在第 19 步之后、第 22 步派发 QA 之前，
  当前实现整步缺失。

## Requirements

- **R1 采集点正确**：diff 必须在 Adapter 状态仍存活时采集（`dispose` 之后
  `collectChanges` 返回 `NOT_FOUND`），且在 Keel 自己 `commitAll` **之前**采集
  —— 提交之后工作树干净，再读就是空 diff（「假空」）。
- **R2 基线正确**：diff 必须覆盖「工作区改动 + 本轮新提交」。模型自己 `git commit`
  之后 `git status` 是干净的，只用 `status --porcelain` 会把「真的改了」误报成空。
- **R3 载体持久化**：采集结果落 Fact Plane（event），使 `qa` / `review`
  （运行在后面、ContextBuilder 在前面）能读到；不可只放在内存里跨调用传递。
- **R4 上下文注入**：`qa` / `review` 的配方里加入 diff section，内容来自 develop
  那一轮的真实采集结果；`ContextBuilt` 事件据此可回答「QA 当时看到了哪份 diff」。
- **R5 fail-closed**：`develop` 若「测得的改动为空」（0 文件 0 提交）却声称
  `implemented`，Run 不得写 `SUCCEEDED`，按可重试失败处理（`PROTOCOL_ERROR`）。
  **测不出来 ≠ 没改动**：采集本身失败（`collectChanges` 返回 err）不 fail-closed，
  但要如实记进事件，不许静默当成「没改动」。
- **R6 不夸大**：patch 体积有上限，截断必须在数据与注入文本里都显式标注；
  未采集到就写 `null` / `false`，不用空串或 0 冒充「没有改动」。

## Acceptance Criteria

- [x] **AC1** `develop` 结束后存在 `WorkspaceDiffCollected` 事件，payload 含
      `stage` / `attempt` / `collected` / `files_changed` / `commits` / `is_dirty` /
      `patch` / `patch_chars` / `patch_truncated`；`patch` 超 `PATCH_LIMIT` 时被截断且
      `patch_truncated=true`。
- [x] **AC2** `qa` / `review` 的 `ContextBuilt` 事件里出现 id=`diff` 的 section，
      `source_ref` 指向那条 `WorkspaceDiffCollected` 事件的 seq。
- [x] **AC3** 采集结果覆盖「模型自己 commit 的情况」：`git-diff.test.ts` 里先在临时仓
      commit，再 `collectGitDiff({since})`，仍能报出文件与 commit。
- [x] **AC4** fail-closed 生效：stub adapter 在 `develop` 返回空 diff →
      run 不被置 `SUCCEEDED`，走 `RunFailed` → `T-030` 重试（`run-failure.test.ts` 用例 D）。
- [x] **AC5** 采集失败不阻断：stub `collectChanges` 返回 err → run 仍 `SUCCEEDED`，
      事件里 `collected=false` 且带 `collect_error`（用例 E）。
- [x] **AC6** 真机回归：跑一次完整任务，`develop` 的 `WorkspaceDiffCollected`
      与 `commitAll` 产生的 commit 对得上，QA 的 `ContextBuilt` 里能看到 diff section。
- [x] **AC7** `pnpm run check` 全绿（lint / typecheck / boundaries / generated /
      transitions / purity / test；35 文件 433 通过）。

## Non-Goals

- **不接线 `post_develop` 的 Policy 决策点**（`files_drift_ratio` / `actual_files_changed`
  规则求值）。`docs/05-contracts/policy-engine.md` §2.2 定义了它，但 R6 / issue #23
  刻意留空（`loadPolicyFacts` 对未接线的决策点直接抛错，正是为了不假装求值过）。
  本任务只把**事实**采出来，求值另开任务。事件 payload 已经带 `files_changed`，
  后续接线不需要再改采集层。
- 不做 diff 的语义摘要（哪个文件对应哪条 AC），那是阶段二的 ModelProvider 工作。
- 不改 `estimated_files_changed` 的声明值来源（仍在 RFC 里由模型填）。

## 实测记录（2026-10-26）

真机（本机 claude 2.1.300 + magpie 网关，临时仓，`wallClockS: 600`）：
task `30245f12`（前两次试跑因反馈文本被模型合理否决而中止，见下）

| 阶段 | status | cost_usd |
|---|---|---|
| pm | SUCCEEDED | 0.029563 |
| rfc_draft | SUCCEEDED | 0.028755 |
| develop | SUCCEEDED | 0.027959 |
| qa | SUCCEEDED | 0.023639 |
| review | SUCCEEDED | 0.019249 |

- 终态 **S-DONE**，全程 34.5s，合计 ≈$0.13
- develop 的 diff 事件（seq 42）：`files_changed:[{path:'README.md',change:'modified'}]`、
  `patch_chars:167`、`is_dirty:true`、`commits:[]`（commitAll 在采集之后，符合设计）
- 分支上的 `6aaf5c5 develop: run fd906a6b` 确实改了 README.md（+2 行）—— 事件与 commit 一致
- QA 的 `ContextBuilt` sections：`role` / `rfc` / **`diff`(72 tokens,
  `event:WorkspaceDiffCollected@42`)**；qa / review 自己的 diff 事件为空（只读阶段，符合预期）

**试跑教训（给后来的验收）**：前两次 PM 分别判 `unclear` 与 `reject` ——
第二次的理由是「README 明确写着『当前导出接口没有任何筛选参数』，按反馈补一句会
写成与代码事实相反的文档」。这不是模型不听话，是**夹具自相矛盾**：
验收的反馈文本必须让需求在夹具仓库里真实成立，否则模型合理否决，
而失败的证据会被误读成「harness 不行」。

## Notes / 风险

- 现有 13 处测试 stub 的 `collectChanges` 恒返回空 diff；R5 生效后它们会集体变红。
  这是**检查确实咬住了**的表现，不是回归——按 stage 返回一份「改了一个文件」的
  diff 即可（本任务要改的测试面见 `implement.md`）。
- `git diff` 在超大改动下会产出巨量文本：上限 + 截断标记是硬要求（R6）。
