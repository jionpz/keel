# 控制台（只读 Web 面板）

> 来源：`10-27-console-and-demo-app` 的第一份真实前端代码（`src/cli/console*.ts`）。
> 在出现第二个 UI 之前，这些约定只覆盖「本地只读观测面」这一类，不要外推成通用前端规范。

## 形态：单文件、零构建、零依赖

- 页面是 `src/cli/console-page.ts` 里的一个模板字符串；没有 React / Vite / CDN。
- 客户端 JS 用字符串拼接，**不要用模板字符串** —— 会和外层模板字符串冲突。
- 新增页面能力时先问：能不能用原生 DOM + `fetch` 完成？能就不要引依赖。

## 只读边界

- 只发 `GET`；写方法一律 `405`。
- 数据库访问只走 `asRole('keel_control')`，并且只发 `SELECT`。
- 只绑定 `127.0.0.1`，不做鉴权 —— 因此**不要**把它暴露到公网。

## 数据口径必须与 CLI 一致

- 页面上的 task / run / event 必须能和 `keel status`、`pnpm run timeline -- <id>` 对上。
- 新增字段时先看 CLI 查询，避免出现两套事实口径。
- 状态集合与主路径来自代码（`src/shared/ids.ts`、`src/control/transition/table.ts`），
  不要在页面里手抄一份状态表。

### 只读字段范围（`src/cli/console.ts`）

- `GET /api/tasks`（列表）：`id, title, status, control_mode, risk, complexity,
  work_branch, base_branch, budget_usd, created_at, updated_at, terminal_at,
  repo, repo_provider`，外加 `LEFT JOIN LATERAL` 聚合出来的
  `run_count, total_cost_usd, total_tokens, event_count`（只读统计，不写回）。
- `GET /api/tasks/:id`（详情）：
  - `task`：列表字段 + `repo_id, current_run_id`；
  - `runs`：`id, stage, role, attempt, status, harness_id, harness_tier, session_ref,
    started_at, ended_at, error_kind, error_detail, tokens_in, tokens_out, cost_usd, cost_basis`；
  - `events`：`seq, run_id, type, payload, trace_id, span_id, occurred_at`（按 `seq` 升序）；
  - `artifacts`：`id, kind, key, version, schema_version, produced_by_run, committed_at,
    committed_at_seq, superseded_by, body` —— 返回**全部版本**（`kind, key, version DESC`），
    由前端用 `superseded_by` 串成版本链，而不是在 SQL 里只挑最新版；
  - `feedbacks`：`task_feedback JOIN feedback` 取 `id, source, external_ref, body, received_at`；
  - `timers`：`id, run_id, kind, due_at, state, fired_at, created_at, updated_at`。
- 以上查询全部走 `asRole('keel_control')` 且只含 `SELECT`；新增字段时同步扩充
  `src/cli/console.test.ts` 里的注入式 `fakeQuery` 分支，保持可测。

## 无感刷新与状态保持

- 5 秒轮询分两段指纹：列表用 `tasksSig`、详情用 `detailSig`（由 `updated_at`、
  最大 `event.seq`、run 状态等拼成）。指纹未变时**只更新心跳时间戳，不重绘 DOM**；
  变化时才整块重渲染，避免无意义的展开态/滚动位置丢失。
- 重绘前把 `details[data-expand-id]` 的 `open` 集合与滚动容器的 `scrollTop` 存下来，
  重绘后按同 id 恢复。新增可折叠节点时必须给稳定的 `data-expand-id`
  （如 `art-raw-<kind>-<version>`），否则刷新后会丢展开态。
- 选中任务与激活 Tab 同步到 URL Hash：`#task=<id>&tab=<tab>`（`overview|runs|diff|timeline`）。
  页面加载与 `hashchange` 都从 Hash 恢复；浏览器前进/后退、刷新、直接分享链接都要能定位到原位。

## 错误纪律

- 不存在的 task → `404`，不返回空对象冒充「没有任务」。
- 数据库不可用 → `503`，并在响应里带连接串提示；页面显示错误，不显示空白。
- 测试注入假 `query` 起真实 http server，不依赖数据库；真实数据由手工对账验证。
