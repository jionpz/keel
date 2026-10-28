# 控制台 UI/UX 重设计（Keel Observatory）

## Goal

将 `keel console`（`http://127.0.0.1:4321`）从简陋的「数据库 JSON 裸表平铺页」重设计为专业级 AI 工程运行时观测工作台（**Keel Observatory**），在不破坏只读边界与零依赖约束的前提下，让开发者无需手动翻阅原始 JSON 即可直观洞察任务的**需求起源（Feedback）、真实状态流转轨迹、结构化方案与评审（RFC / Stage Outcomes / Policy）、执行耗时与 Token 成本、上下文组装水位（ContextBuilder）、代码变更 Diff 以及完整事件流**，并彻底解决 5 秒自动刷新重置页面展开态与视图状态的交互痛点。

## Background & Confirmed Facts

1. **架构与只读红线**（[`docs/09-roadmap.md`](../../../docs/09-roadmap.md)、[`.trellis/spec/frontend/console-guidelines.md`](../../spec/frontend/console-guidelines.md)）：
   - 控制台是 Fact Plane 的只读消费者：只接受 `GET`/`HEAD`（写方法返回 `405`），只绑定 `127.0.0.1`，通过 `asRole('keel_control')` 仅执行 `SELECT`；
   - 单命令启动（`pnpm run console`），零外部运行时依赖、零前端打包工具、零外部 CDN（内联于 `src/cli/console-page.ts`）；
   - 数据口径必须与 `keel status <id>` 及 `pnpm run timeline -- <id>` 严格一致。
2. **现有实现缺陷（代码与实测证据）**：
   - **后端查询缺漏（[`src/cli/console.ts:128-207`](../../../src/cli/console.ts)）**：
     - 未查询 `feedback` / `task_feedback` 表，任务详情缺失原始需求正文、来源（如 `github`）与外部链接（`external_ref`）；
     - `run` 查询遗漏 `id`、`tokens_in`、`tokens_out`、`cost_usd`、`cost_basis`、`session_ref`，无法展示单次与累计 Token 消耗、成本及 Run 与 Event/Artifact 的关联；
     - `artifact` 查询遗漏 `id`、`schema_version`、`produced_by_run`、`committed_at_seq`、`superseded_by`；
     - 未查询 `timer` 表（`clarification_ttl` / `wall_clock` 定时器状态）；
     - `/api/tasks` 列表未附带 run 统计与成本摘要。
   - **状态机视图视觉误导 Bug（[`src/cli/console-page.ts:200-213`](../../../src/cli/console-page.ts)）**：
     - 当任务处于非主路径状态（如 `S-HUMAN_REVIEW`、`S-NEED_CLARIFICATION`、`S-FAILED`、`S-REJECTED`、`S-ABANDONED`）时，`MAIN_PATH.indexOf(status)` 为 `-1`，循环内 `reached` 恒为 `true`，导致整条主路径从 `S-NEW` 到 `S-DONE` 全部被错误渲染为绿色 `.done`；
     - 未结合 `TaskStatusChanged` 事件区分「真实经过的节点」与「跳过的分支节点（如走 `T-004` 跳过 `S-BRAINSTORM`）」。
   - **核心工程信息被塞进裸 JSON（[`src/cli/console-page.ts:268-295`](../../../src/cli/console-page.ts)）**：
     - `rfc`、`stage_outcome`、`policy_decision`、`critic_review`、`checkpoint`、`state`、`capability_request` 全部仅用 `JSON.stringify(art.body, null, 2)` 渲染；
     - `WorkspaceDiffCollected` 中的 `patch`（Unified Git Diff）和 `files_changed` 未提取展示，只能在一行带 `\n` 的 JSON 中查看；
     - `SideEffectApplied(CreatePullRequest)` 中的 PR 链接（`pr_url` / `pr_number`）和 `ContextBuilt` 中的上下文 Token 预算水位（`total_tokens / budget_tokens`、`sections`、`dropped`）被埋没在事件列表底部。
   - **交互体验缺陷（[`src/cli/console-page.ts:324-338`](../../../src/cli/console-page.ts)）**：
     - 每 5 秒自动刷新直接覆写 `detail.innerHTML`，导致用户展开的 `<details>`、滚动位置等瞬间丢失；
     - 右侧单列无限纵向堆叠，无多视图 Tab 切换；
     - 左侧任务列表无关键词搜索、无按状态分类过滤、无全局概览指标；
     - 无 URL Hash 路由同步（刷新浏览器丢失当前选中 Task 与 Tab），无快捷复制与手动明暗主题切换。

## Requirements

### R1 只读 API 事实补齐（`src/cli/console.ts`）

- **R1.1 `/api/tasks` 列表增强**：在保持原有字段（`id, title, status, control_mode, created_at, updated_at, terminal_at, repo`）基础上，通过只读聚合子查询补充每个任务的 `run_count`、`total_cost_usd`、`total_tokens`、`event_count`，支撑左侧高信息密度任务卡片与全局 KPI 统计。
- **R1.2 `/api/tasks/:id` 详情增强**：
  - `task`：补齐 `budget_usd`、`current_run_id`；
  - `runs`：补齐 `id, tokens_in, tokens_out, cost_usd, cost_basis, session_ref`；
  - `artifacts`：返回该任务全部版本产物（或最新有效版 + 历史版本标识 `id, kind, key, version, schema_version, produced_by_run, committed_at, committed_at_seq, superseded_by, body`），使前端既能展示当前生效产物，又能查看版本演进；
  - `events`：补齐 `trace_id, span_id`（连同 `seq, run_id, type, payload, occurred_at`）；
  - `feedbacks`（新增字段）：通过 `task_feedback JOIN feedback` 返回关联的原始反馈列表（`id, source, external_ref, body, received_at`）；
  - `timers`（新增字段）：查询 `timer` 表返回该任务的定时器记录（`id, run_id, kind, due_at, state, fired_at, created_at`）。
- **R1.3 向后兼容与只读保障**：所有查询严格走 `asRole('keel_control')` 且只含 `SELECT`；兼容现有 `src/cli/console.test.ts` 的注入式 `fakeQuery` 并扩充单测。

### R2 左侧任务导航栏（Task Explorer）与全局概览

- **R2.1 顶部控制台栏**：展示品牌标识、数据库连接/健康状态指示灯、自动刷新开关与状态提示、手动刷新按钮、以及明/暗/跟随系统主题切换按钮（持久化到 `localStorage`）。
- **R2.2 全局 KPI 指标卡**：顶部汇总显示总任务数、活跃运行中（Stage）、待人工介入/门禁（Gate）、已完成（`S-DONE`）及异常终态计数。
- **R2.3 搜索与分类筛选**：
  - 支持按标题、Task ID、仓库名或分支名即时搜索；
  - 支持按状态分类胶囊（`全部` / `运行中 Stage` / `待介入 Gate` / `已完成 Done` / `异常终态`）一键过滤。
- **R2.4 高密度任务卡片**：每张任务卡片清晰展示标题、状态徽章（区分 Stage / Gate / Done / Bad 语义色彩与运行脉冲点）、Control Mode 标签、短 ID、仓库短名、耗时/更新时间、以及 Run 数量与成本摘要。

### R3 任务驾驶舱头部（Task Cockpit Header）与真实状态机轨迹图

- **R3.1 驾驶舱头部**：
  - 展示任务标题、状态大徽章、`control_mode`（`auto` / `paused` / `human`）、风险 `risk` 与复杂度 `complexity` 标签；
  - 展示代码仓库链接（GitHub URL 可直接点击外跳）、分支流向（`work_branch → base_branch`）、提取自事件的 **PR 胶囊外链**（如 `PR #2`）；
  - 展示关键指标汇总卡：**总耗时**、**Run 次数**、**总 Token（In / Out）**、**累计成本（含 `cost_basis` 说明与 `budget_usd` 对比）**、**事件总数**；
  - 提供一键复制 `task_id`、`keel status <id>`、`pnpm run timeline -- <id>` 命令的快捷按钮。
- **R3.2 基于事件流的真实状态机轨迹图（修复非主路径全绿 Bug）**：
  - 从任务的 `TaskStatusChanged` 事件流重建真实走过的状态集合、转移 ID（如 `T-001`, `T-004`, `T-012`）与各状态停留时长；
  - 主路径节点明确区分 4 种视觉状态：**已实际通过（Visited）**、**未经过/已跳过（Skipped，如未走 `S-BRAINSTORM` 时显示虚线旁路）**、**当前所在状态（Current，带高亮脉冲）**、**尚未到达（Pending）**；
  - 当任务处于非主路径状态（Gate / 终态分支，如 `S-HUMAN_REVIEW`、`S-NEED_CLARIFICATION`、`S-REJECTED`、`S-ABANDONED`、`S-FAILED`）时，绝不把未经过的主路径节点标绿，而是在分叉点高亮展示当前所处的旁路/终态节点及触发原因（来自最近一次 `TaskStatusChanged` / `PolicyEvaluated` / `stage_outcome`）；
  - 底部以结构化芯片展示从 `meta.transitions` 匹配的「可能的下一次转移（Transition ID → 目标状态、触发事件、Guard 守卫条件）」。

### R4 多视图结构化工作台（Tabbed Workspace）

提供 4 个核心视图 Tab（Tab 切换状态保持并同步至 URL Hash）：

- **R4.1 Tab 1 · 概览与方案（Overview & Artifacts）**：
  - **原始需求卡（Feedback Origin）**：展示触发该任务的原始反馈正文、来源标签（`github` / `manual` 等）、外部引用（若为 URL 或 `owner/repo#num` 则生成可点击链接）及接收时间；
  - **阶段结论流水线（Stage Outcomes）**：按阶段顺序（`pm` → `brainstorm` → `critic` → `rfc_draft` → `develop` → `qa` → `review`）以结构化卡片展示各阶段 `verdict` 徽章（如 `actionable`、`implemented`、`pass`、`fail`）、结论理由 `reason` 与附加细节；
  - **策略裁决卡（Policy Decision）**：结构化展示 `decision_point`、裁决结果 `decision`（如 `auto_develop`）、理由、命中规则表达式 `matched_rules` 及求值时的 `facts_snapshot`；
  - **RFC 规格说明书视图**：将 `rfc` 产物渲染为可读性极佳的工程文档卡片——含标题、问题描述（Problem）、目标列表（Goals）、非目标（Non-Goals）、拟议变更（Summary / Approach / Affected Areas 文件标签）、验收标准表格（`AC1..ACn` + 验证方式 `verifiable_by`）及 `policy_facts`；
  - **其他产物与通用视图**：支持 `state`、`checkpoint`、`critic_review`、`capability_request` 的结构化展示，且所有产物卡片均支持一键展开/切换查看 **Raw JSON** 及历史被取代版本（`superseded_by`）。
- **R4.2 Tab 2 · 执行与上下文（Runs & Context）**：
  - 展示每次 Run 的完整卡片/表格：Stage、Role、Attempt、Status 徽章、Harness（`harness_id` + `harness_tier`）、耗时（精确到秒/毫秒）、Token 明细（`tokens_in` / `tokens_out`）、成本（`$cost_usd` + `cost_basis`）、错误详情（若有）及关联 Timer 状态；
  - **Context Builder 透视**：将关联于该 Run 的 `ContextBuilt` 事件可视化为 **Token 预算水位进度条**（`total_tokens / budget_tokens` 百分比），并列出注入的每个 Section（`id`、`source_ref`、`tokens`、`priority`）及被裁剪丢弃的 `dropped` 列表；
  - 支持点击任意 Run 跳转到事件时间线并按该 `run_id` 过滤。
- **R4.3 Tab 3 · 代码变更（Code Diff）**：
  - 自动提取 `WorkspaceDiffCollected` 事件中的变更记录（按阶段/attempt 选择或汇总查看）；
  - 顶部展示变更统计（变更文件数 `files_changed`、新增行数 `+N`、删除行数 `-M`、Commit 列表、是否截断 `patch_truncated`）；
  - 左侧/顶部提供变更文件快速跳转导航，主体提供**语法着色的 Unified Diff 视图**（清晰区分 `@@` hunk 头、`+` 新增绿行、`-` 删除红行、双列行号与等宽代码排版）。
- **R4.4 Tab 4 · 事件时间线（Event Timeline）**：
  - 支持按事件类别筛选（`全部` / `状态流转` / `Run 生命周期` / `上下文与提案` / `副作用与策略`）、按关联 `run_id` 筛选、以及按关键词搜索；
  - 每条事件除展示 `seq`、相对/绝对时间、事件类型徽章、关联 Run 短 ID 外，自动提炼一行**人类可读摘要（Human Summary）**（例如：`T-004: S-PM_ANALYZING → S-RFC_DRAFT (on RunSucceeded)`、`CreatePullRequest → #2`、`ContextBuilt: PM 108/40000 tokens`）；
  - 支持单条展开/收起格式化 JSON Payload，以及「全部展开 / 全部收起」快捷操作。

### R5 状态保持型无感刷新与 URL 路由同步

- **R5.1 零抖动增量刷新**：
  - 5 秒自动轮询时，对比新旧数据的指纹（如任务列表与当前详情的最新 `updated_at` / 最大 `event.seq` / `run` 状态）；若数据未发生变化，仅更新顶部心跳时间戳，**不重绘详情区 DOM**；
  - 当数据发生变化需要重绘时，完整保留当前的 UI 状态：激活的 Tab、搜索词、筛选条件、已展开的 `<details>` 节点集合（通过稳定的 `data-expand-id` 标记恢复 `open` 属性）以及滚动容器的 `scrollTop`。
- **R5.2 URL Hash 路由同步**：
  - 将当前选中的 `task` 与 `tab` 同步到 `location.hash`（如 `#task=<uuid>&tab=overview`），支持页面刷新后原位恢复、浏览器前进/后退以及链接直接分享定位。

## Acceptance Criteria

- [x] **AC1（只读与边界合规）**：`src/cli/console.ts` 与 `src/cli/console-page.ts` 仅含 `GET`/`HEAD` 与 `asRole('keel_control')` 的 `SELECT` 查询，无任何 `INSERT`/`UPDATE`/`DELETE`，不引入任何外部依赖，`pnpm run check`（含 lint、typecheck、boundaries、check:generated、check:transitions、check:purity、vitest）全绿。
- [x] **AC2（API 数据完整性）**：`/api/tasks` 与 `/api/tasks/:id` 返回补齐后的 `runs`（含 token/cost/id）、`feedbacks`、`timers`、`artifacts`、`events`，且对不存在/非法 task ID 仍返回 `404`，数据库故障仍返回 `503`。
- [x] **AC3（状态机轨迹修复与还原）**：
  - 查看处于 `S-DONE` 且跳过 `S-BRAINSTORM` 的任务（如 `ab3d9159`）时，`S-BRAINSTORM` 显示为跳过态而非已完成绿态；
  - 查看处于 `S-HUMAN_REVIEW` 的任务（如 `5ec1ada9`）时，后续未到达的主路径节点（`S-DEVELOPING`..`S-DONE`）绝不显示为绿色已完成，且清晰高亮 `S-HUMAN_REVIEW` 门禁状态与原因。
- [x] **AC4（结构化多视图渲染）**：
  - 在「概览与方案」Tab 可直接看到格式化排版的需求 Feedback、各阶段 `stage_outcome` 结论卡片、Policy 裁决卡片与 RFC 文档（含 AC 列表），无需点开裸 JSON；
  - 在「执行与上下文」Tab 可看到每个 Run 的耗时、Token、成本及 `ContextBuilt` 预算水位条；
  - 在「代码变更」Tab 可看到 `ab3d9159` 的 5 个变更文件列表与红绿高亮的 Git Diff 视图；
  - 在「事件时间线」Tab 可按类型/Run 过滤事件并看到每条事件的人类可读摘要。
- [x] **AC5（无感刷新与状态保持）**：开启 5s 自动刷新时，展开任意 `<details>` 或切换到任意 Tab / 搜索过滤条件，经过多次自动刷新周期后，展开态、激活 Tab、过滤条件与滚动位置均不丢失；刷新浏览器页面后通过 URL Hash 自动恢复到原选中 Task 与 Tab。

## Out of Scope

- 不提供任何写操作（如在页面上点击按钮触发 Pause / Resume / Approve / Reject / 新建任务）—— 控制台保持严格只读。
- 不引入 React、Vue、Tailwind、Vite 或任何 CDN 外部脚本/字体/图标库（所有图标使用内联 SVG，样式使用现代原生 CSS 变量与 Grid/Flex）。
- 不修改数据库 Schema（不新增 migration），完全基于现有 Fact Plane 表结构进行只读查询。
