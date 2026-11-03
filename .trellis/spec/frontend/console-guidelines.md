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
  repo_id, repo, repo_provider`，外加 `LEFT JOIN LATERAL` 聚合出来的
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

## 人话层：术语与「一句话现状」

- 机器码（`S-*` / `T-*` / `I8`）是事实，但页面必须同时给中文短名：徽章、侧栏、轨迹统一
  「中文在前、机器码在后」，机器码降为次要视觉层级（`.badge-zh` / `.badge-code`）。
- 状态与事件的中文标签由 `GET /api/meta` 的 `statusLabels` / `eventLabels` 下发。
  `ids.ts` 是状态集合的定义处，`console.ts` 是标签处，**页面里不要再硬编码第三份状态词表**。
- 详情页标题下有一条确定性生成的「一句话现状」（`renderStatusSummary`）：
  现在在哪、在等什么、下一步能做什么。它只能由已有数据推导，**不调用模型、不写死单条任务文案**；
  终态要提示「终态不可再变更（I8）」。
- 术语表（`GLOSSARY`）是纯说明文案，允许写在页面里；新增术语时同步 `statusLabels` /
  `eventLabels` 的词表，避免同义词漂移。
- 状态机的「停留时长」用**节点内时长条**表达（`durationPct`，对数刻度、按当前任务最长阶段归一），
  **不要**用节点宽度：10 个节点在 ~990px 内容区会被 `min-width` 压平，宽度差异不可辨识。
  终态不再累计「已停留」，否则会显示成完成后的天数。
- 偏离主路径（如 `S-HUMAN_REVIEW`）时，轨道必须标出「从哪个阶段分出」：出发节点加 `.departed`，
  分支说明条给出分出转移与当前已停留时长。否则轨道看起来像正常停在那个阶段。
- 时长文案统一走 `fmtDurationMs`：ms → s → `Nm Ns` → `Nh Nm` → `N天 Nh`（≥2 天才换天），
  不要在各处自己拼单位。
- 「已停留」类实时文案在节点上带 `data-since` + `data-prefix`，由 `tickElapsed()` 在轮询节拍里
  单独刷新文本 —— 指纹未变时不会重绘 DOM，不这样写时长会冻住。

## 任务模式 / 项目模式

- 页面有两种视图，共用同一个侧栏骨架：**任务模式**以 task 为主体，**项目模式**以仓库为主体。
  切换只改可见容器与按钮态（`applyModeChrome`），不要复制两套侧栏。
- 项目由客户端按 `repo`（仓库地址）归组，**不是** `repo_id`：`repo` 表没有 remote_url 唯一约束，
  按 id 分会把同一项目拆成两行。聚合值（任务数、状态分布、轮次、成本）都从 `/api/tasks` 的
  现成字段算，不新增写路径、不新增聚合接口。
- 项目视图只做聚合与跳转：任务明细仍然回任务模式看，避免一个事实出现两种口径。
- 模式与选中项进 URL Hash：`#mode=projects&repo=<url>` 与 `#task=<id>&tab=<tab>`；
  只有 `task` 键的链接回落到任务模式。5s 轮询必须保持当前模式与选中项目。
- 侧栏的计数只写一处：状态计数长在筛选 chip 上（`.pill-n`），不要再造一排 KPI 方块重复表达。

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
