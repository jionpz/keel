# 技术设计 · 控制台 UI/UX 重设计（Keel Observatory）

## 1. 架构与模块边界

保持 `src/cli/console.ts` + `src/cli/console-page.ts` 的双文件零依赖架构，完全符合 `.dependency-cruiser.cjs` 的边界规则与 `.trellis/spec/frontend/console-guidelines.md`：

```
src/cli/console.ts        HTTP 路由 + SQL 只读查询组装（asRole('keel_control')）
src/cli/console-page.ts   内联 HTML5 + CSS Design System + 模块化原生 JS 视图引擎
src/cli/console.test.ts   HTTP 路由、状态码、数据结构及页面关键组件渲染契约单测
```

- **只读与权限不变量**：只响应 `GET` / `HEAD`；所有 SQL 经由 `deps.query`（生产环境绑定 `asRole('keel_control')`）执行，且仅含 `SELECT`。
- **模板字符串安全约定**：`src/cli/console-page.ts` 导出外层模板字符串 `CONSOLE_HTML`，内部客户端 JS 统一使用普通字符串拼接与数组 `.join('')`，绝不使用反引号或 `${...}`，彻底杜绝转义冲突。

## 2. 后端只读 API 数据契约（`src/cli/console.ts`）

### 2.1 `GET /api/tasks`

查询语句：

```sql
SELECT t.id, t.title, t.status, t.control_mode, t.risk, t.complexity,
       t.work_branch, t.base_branch, t.budget_usd,
       t.created_at, t.updated_at, t.terminal_at,
       r.remote_url AS repo, r.provider AS repo_provider,
       COALESCE(rs.run_count, 0)::int AS run_count,
       COALESCE(rs.total_cost_usd, 0):: text AS total_cost_usd,
       COALESCE(rs.total_tokens, 0)::text AS total_tokens
FROM task t
JOIN repo r ON r.id = t.repo_id
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS run_count,
         SUM(COALESCE(cost_usd, 0)) AS total_cost_usd,
         SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)) AS total_tokens
  FROM run WHERE task_id = t.id
) rs ON true
ORDER BY t.updated_at DESC
```

> 注：SQL 保留 `FROM task t` 与 `JOIN repo r` 特征子串，确保 `src/cli/console.test.ts` 中基于子串匹配的 `fakeQuery` 100% 兼容。

### 2.2 `GET /api/tasks/:id`

在 `loadTaskDetail(query, id)` 中并行/顺序执行以下只读查询，组装返回 `{ task, runs, events, artifacts, feedbacks, timers }`：

1. **`task`**：
   ```sql
   SELECT t.id, t.title, t.status, t.control_mode, t.repo_id, t.base_branch, t.work_branch,
          t.risk, t.complexity, t.budget_usd, t.current_run_id,
          t.created_at, t.updated_at, t.terminal_at,
          r.remote_url AS repo, r.provider AS repo_provider
   FROM task t JOIN repo r ON r.id = t.repo_id
   WHERE t.id = $1
   ```
2. **`runs`**：
   ```sql
   SELECT id, stage, role, attempt, status, harness_id, harness_tier, session_ref,
          started_at, ended_at, error_kind, error_detail,
          tokens_in, tokens_out, cost_usd, cost_basis
   FROM run WHERE task_id = $1
   ORDER BY started_at NULLS LAST, attempt
   ```
3. **`events`**：
   ```sql
   SELECT seq, run_id, type, payload, trace_id, span_id, occurred_at
   FROM event WHERE task_id = $1 ORDER BY seq
   ```
4. **`artifacts`**：
   ```sql
   SELECT id, kind, key, version, schema_version, produced_by_run,
          committed_at, committed_at_seq, superseded_by, body
   FROM artifact WHERE task_id = $1
   ORDER BY kind, key, version DESC
   ```
   > 前端默认展示 `superseded_by === null` 的当前生效版本，并在同 `(kind, key)` 存在旧版本时提供「历史版本 (v1..vN)」切换/折叠查看。对于单测中未带 `superseded_by` 字段的 mock 数据，`!art.superseded_by` 同样兼容视为最新版。
5. **`feedbacks`**：
   ```sql
   SELECT f.id, f.source, f.external_ref, f.body, f.received_at
   FROM task_feedback tf JOIN feedback f ON f.id = tf.feedback_id
   WHERE tf.task_id = $1
   ORDER BY f.received_at
   ```
6. **`timers`**：
   ```sql
   SELECT id, run_id, kind, due_at, state, fired_at, created_at, updated_at
   FROM timer WHERE task_id = $1
   ORDER BY created_at
   ```

## 3. 前端状态机轨迹还原算法（Trajectory Reconstruction）

为解决原本按 `MAIN_PATH` 下标一刀切涂绿的 Bug，前端引入 `analyzeTrajectory(task, events, meta)` 纯函数：

1. **提取真实转移链**：
   遍历 `events` 中 `type === 'TaskStatusChanged'` 的事件，按 `seq` 顺序记录：
   - `visitedStatuses`（集合）：所有事件中出现过的 `payload.from` 与 `payload.to`，外加 `task.status`；
   - `transitionsTaken`（数组）：`{ seq, from, to, transition, event, occurred_at }`，并由相邻两次 `TaskStatusChanged` 的 `occurred_at` 计算每个状态的停留耗时 `durationMs`。
2. **主路径节点四态判定**：
   对 `MAIN_PATH` 中的每个节点 `s`（下标 `idx`）：
   - `current`：`s === task.status`；
   - `done`：`s !== task.status` 且 `visitedStatuses.has(s)`；
   - `skipped`：`!visitedStatuses.has(s)`，但存在下标 `laterIdx > idx` 的主路径节点已被访问过（即 `visitedStatuses` 中存在 `MAIN_PATH[laterIdx]`）—— 例如走 `T-004` 从 `S-PM_ANALYZING` 直接到 `S-RFC_DRAFT` 时，`S-BRAINSTORM` 判定为 `skipped`（虚线旁路样式 + `已跳过` 标记）；
   - `pending`：尚未到达。
   - **兼容无事件单测/降级场景**：若 `events` 中没有任何 `TaskStatusChanged` 事件，仅当 `MAIN_PATH.indexOf(task.status) >= 0` 时將 `task.status` 之前的节点视为 `done`；若 `task.status` 不在主路径且无事件，则主路径节点全部为 `pending`，绝不誤标为 `done`。
3. **非主路径（Gate / 异常终态）分支横幅**：
   当 `MAIN_PATH.indexOf(task.status) === -1`（如 `S-HUMAN_REVIEW`、`S-NEED_CLARIFICATION`、`S-FAILED`、`S-REJECTED`、`S-ABANDONED`）时，在主路径条下方渲染醒目的**分叉节点横幅（Branch Callout）**，展示：
   - 从哪个前置状态（最后一个 `TaskStatusChanged.from`）经由哪条转移（如 `T-013` / `T-020` / `T-031`）进入当前状态；
   - 触发原因摘要（自动关联最近的 `PolicyEvaluated` 理由或失败的 `stage_outcome` / `Run` 错误信息）。

## 4. 多视图工作台与结构化渲染器设计

### 4.1 视觉系统（CSS Design Tokens）
- 采用深邃、克制的现代工程仪表盘配色（支持 `data-theme="dark" | "light"` 手动切换及系统默认）：
  - 语义色：Stage 运行蓝 (`--stage`)、Gate 门禁琥珀 (`--gate`)、Done 成功翠绿 (`--done`)、Bad 错误珊瑚红 (`--bad`)、Skipped 虚线中性灰；
  - 布局：左侧固定宽度 `360px`（高密度任务导航栏，独立滚动），右侧自适应 `1fr`（顶部粘性摘要栏 + 状态机面板 + Tab 工作区）。

### 4.2 四个核心 Tab 面板
1. **Tab `overview`（概览与方案）**：
   - **原始需求（Feedback Card）**：渲染 `feedbacks`，自动识别 GitHub Issue 引用（如 `https://github.com/...` 或 `owner/repo#num`）生成外链，保留正文换行排版；
   - **阶段结论流（Stage Outcomes Strip）**：按 `pm` → `brainstorm` → `critic` → `rfc_draft` → `develop` → `qa` → `review` 顺序排列已产出的 `stage_outcome` 产物，显示 `verdict` 语义徽章、耗时关联与 `reason` 正文；
   - **策略裁决（Policy Decisions）**：渲染 `policy_decision` 产物的判定点、决策动作、命中规则表格与 `facts_snapshot` 键值胶囊；
   - **RFC 规格说明书（Structured RFC Viewer）**：将 `rfc.body` 拆解为「问题背景 Problem」、「目标 Goals & 非目标 Non-Goals（双栏对照）」、「方案设计 Proposed Change（含受影响文件代码标签）」、「验收标准 Acceptance Criteria（带 `AC1..ACn` 编号与验证方式徽章）」；
   - **其余产物（State / Checkpoint / CriticReview / CapabilityRequest）**：按各自 Schema 字段结构化渲染，并提供统一的 `<details data-expand-id="raw-art-...">` 查看原始 JSON。
2. **Tab `runs`（执行与上下文）**：
   - **汇总统计条**：总 Run 数、成功/失败数、总耗时、总 `tokens_in` / `tokens_out`、总成本（区分 `billed` / `estimated` / `unavailable`）；
   - **Run 详情卡片流**：每张 Run 卡片包含：
     - 头部：`stage #attempt`、`role`、`status` 徽章、`harness_id (harness_tier)`、开始/结束时间与精确耗时、点击「在时间线中过滤此 Run」按钮；
     - **Context Builder 仪表盘**：关联该 `run_id` 的 `ContextBuilt` 事件，渲染 `total_tokens / budget_tokens` 水位进度条、各 Section 占比胶囊条（`id`、`source_ref`、`tokens`、`priority`）及 `dropped` 警告；
     - **关联产物与变更摘要**：列出 `produced_by_run === run.id` 的产物与该 Run 采集到的 `WorkspaceDiffCollected` 文件变更数；
     - **Timer 与错误诊断**：若该 Run 关联 `timer` 或 `error_kind`/`error_detail`，以高亮告警块展示。
3. **Tab `diff`（代码变更）**：
   - 从 `events` 中筛选 `type === 'WorkspaceDiffCollected'` 且含有效 `patch` 或 `files_changed` 的记录（若多次采集可切换查看）；
   - **文件导航栏**：列出 `files_changed` 及每个文件的 `+added / -removed` 行数统计，点击平滑滚动到对应文件 Diff 块；
   - **Unified Diff 解析与高亮器（`renderUnifiedDiff(patch)`）**：
     按 `diff --git` 切分文件块，解析 `---`/`+++`、`@@ -a,b +c,d @@` hunk 头，逐行计算旧文件行号与新文件行号，对 `+` 行应用绿色背景、` -` 行应用红色背景，语法清晰可读，并提供一键复制完整 Patch 按钮。
4. **Tab `timeline`（事件时间线）**：
   - **过滤工具栏**：事件分类 Pills（`全部`、`状态与门禁`、`Run 执行`、`上下文与提案`、`副作用与策略`）+ 关联 Run 下拉过滤 + 文本搜索框 + 「全部展开 / 全部收起」按钮；
   - **智能事件摘要生成器（`summarizeEvent(ev)`）**：针对 20+ 种事件类型提取关键字段生成一目了然的结构化摘要（如状态迁移箭头、PR 链接、产物版本、策略结果、Diff 行数、耗时等），下方附带可展开的完整 JSON Payload。

## 5. 状态保持型无感刷新与 URL 路由同步

1. **数据指纹对比（Fingerprint Diffing）**：
   - 为 `/api/tasks` 列表计算轻量签名 `tasksSig`（各 task 的 `id:status:updated_at:run_count` 拼接）；
   - 为 `/api/tasks/:id` 详情计算签名 `detailSig`（`task.status:task.updated_at:runs.length:events.lastSeq:artifacts.length`）；
   - 在 5 秒定时器触发的静默刷新（`refreshAll({ silent: true })`）中：
     - 若 `tasksSig` 未变，跳过左侧列表重绘；
     - 若 `detailSig` 未变，**完全跳过右侧详情 DOM 重绘**，仅更新顶部「刚刚 HH:MM:SS」心跳指示器。
2. **展开态与滚动位置恢复（DOM State Preservation）**：
   - 页面上所有 `<details>` 元素均赋予确定性的 `data-expand-id="<kind>-<id>"` 属性；
   - 在用户切换展开态时（监听 `toggle` 事件）或重绘前，将当前所有 `open` 的 `data-expand-id` 记录在 `state.expandedIds` 集合中；
   - 当数据确实发生更新需要重绘 HTML 时，在重绘后自动为命中 `state.expandedIds` 的 `<details>` 恢复 `open` 属性，并恢复主容器的 `scrollTop`。
3. **URL Hash 同步**：
   - 状态变更（选中 Task 或切换 Tab）时通过 `history.replaceState` 更新 `#task=<id>&tab=<tab>`；
   - 页面首次加载及 `hashchange` 时解析 Hash 自动定位到对应 Task 与 Tab。

## 6. 风险与兼容性考量

| 风险 | 预防与回退方案 |
|---|---|
| 旧任务缺少某些字段（如早期 demo 任务无 `feedback`、无 `WorkspaceDiffCollected`、无 `cost_usd`） | 每个渲染模块做严密的空值与缺省态（Empty State）处理，如实显示「未记录原始 Feedback」或「未产生代码变更（0 files）」，绝不抛 JS 异常 |
| 单文件 HTML 体积增大影响可读性 | 在 `src/cli/console-page.ts` 中按样式表（CSS Tokens / Layout / Components）与 JS 逻辑模块（State / Trajectory / Artifact Renderers / Diff Parser / Timeline / Router）分块清晰注释 |
| 现有单测 `src/cli/console.test.ts` 的 `fakeQuery` 断裂 | 保持 `FROM task t JOIN repo r`、`FROM run`、`FROM event`、`FROM artifact` 关键 SQL 特征不变，并对 `feedbacks` / `timers` 做空数组安全兜底 |
