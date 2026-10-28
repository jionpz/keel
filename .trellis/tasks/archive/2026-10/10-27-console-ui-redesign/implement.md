# 执行计划 · 控制台 UI/UX 重设计（Keel Observatory）

## 步骤清单

- [x] **Step 1 · 扩充后端只读查询（`src/cli/console.ts`）**
  - 扩充 `/api/tasks` 查询：增加 `risk, complexity, work_branch, base_branch, budget_usd, repo_provider` 及 `run` 聚合统计（`run_count, total_cost_usd, total_tokens`）。
  - 扩充 `loadTaskDetail`：
    - `task` 补齐 `budget_usd, current_run_id, repo_provider`；
    - `runs` 补齐 `id, session_ref, tokens_in, tokens_out, cost_usd, cost_basis`；
    - `events` 补齐 `trace_id, span_id`；
    - `artifacts` 返回完整元数据（`id, kind, key, version, schema_version, produced_by_run, committed_at, committed_at_seq, superseded_by, body`）；
    - 新增 `feedbacks` 查询（`task_feedback JOIN feedback`）；
    - 新增 `timers` 查询（`FROM timer WHERE task_id = $1`）。
- [x] **Step 2 · 重构控制台前端界面与交互引擎（`src/cli/console-page.ts`）**
  - 建立现代明/暗双主题 CSS 变量系统与双栏工作台布局（左侧 Task Explorer + 右侧 Task Cockpit）。
  - 实现左侧 Task Explorer：全局 KPI 统计卡、关键词搜索、状态分类筛选 Pills、高信息密度任务卡片。
  - 实现驾驶舱头部（Task Cockpit Header）：标题、状态与模式徽章、仓库与分支外链、PR 自动提取外链、耗时/Token/成本汇总指标卡、CLI 命令一键复制。
  - 实现真实状态机轨迹还原器（`analyzeTrajectory` + `renderPipeline`）：修复非主路径全绿 Bug，区分已通过、已跳过、当前脉冲、未到达与旁路分支，展示下一步可转移规则与 Guard。
  - 实现 4 个结构化工作区 Tab：
    - `overview`：原始需求 Feedback、阶段结论流水线（Stage Outcomes）、策略裁决卡（Policy Decision）、结构化 RFC 视图（含 AC 列表）、其他产物视图与 Raw JSON 切换；
    - `runs`：Run 耗时/Token/成本卡片、Context Builder 预算水位进度条与 Sections 明细、点击联动过滤事件；
    - `diff`：变更文件列表与 Unified Git Diff 语法高亮查看器；
    - `timeline`：分类/Run/关键词过滤、人类可读事件摘要生成、展开态保持的 Payload 查看器。
  - 实现无感增量刷新（数据指纹比对 + `data-expand-id` 展开态持久化 + 滚动位置保持）与 URL Hash 路由同步（`#task=<id>&tab=<tab>`）。
- [x] **Step 3 · 扩充单元测试与端到端实测验证（`src/cli/console.test.ts`）**
  - 更新并新增 `src/cli/console.test.ts` 测试用例：验证 `/api/tasks/:id` 返回 `feedbacks`、`timers` 及扩充后的 `runs`/`artifacts` 字段，验证新页面结构与只读约束。
  - 重启本地运行中的 `keel console`（端口 `4321`），对真实数据库 `keel_dev` 中的 8 个任务（含 `ab3d9159` 与 `5ec1ada9`）进行实测核验。
- [x] **Step 4 · 规范同步与全量质量门禁（`.trellis/spec/frontend/console-guidelines.md`）**
  - 更新 `.trellis/spec/frontend/console-guidelines.md` 记录新增的只读字段口径与状态保持刷新约定。
  - 运行 `pnpm run check` 确保 lint、typecheck、boundaries、check:generated、check:transitions、check:purity 与全部测试通过。

## 验证命令

```bash
# 1. 控制台单测
pnpm exec vitest run src/cli/console.test.ts

# 2. 全量质量检查（CI 同款）
pnpm run check

# 3. 真实数据库 API 与页面对账
curl -s http://127.0.0.1:4321/api/tasks | head -c 500
curl -s http://127.0.0.1:4321/api/tasks/ab3d9159-fe98-4a0a-9347-35e57140a760 | head -c 500
```

## 回滚点

- 所有改动集中在 `src/cli/console.ts`、`src/cli/console-page.ts`、`src/cli/console.test.ts` 与 `.trellis/spec/frontend/console-guidelines.md`，不触碰数据库 Schema 或核心三平面代码，可随时通过 `git checkout -- src/cli/console*` 无损回滚。
