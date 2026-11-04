# 控制台（只读 Web 面板）

> 来源：`10-27-console-and-demo-app` 的第一份真实前端代码（`src/cli/console*.ts`）。
> 在出现第二个 UI 之前，这些约定只覆盖「本地观测面（读全量 + 单一人工闸门写入口）」这一类，
> 不要外推成通用前端规范。

## 形态：单文件、零构建、零依赖

- 页面是 `src/cli/console-page.ts` 里的一个模板字符串；没有 React / Vite / CDN。
- 客户端 JS 用字符串拼接，**不要用模板字符串** —— 会和外层模板字符串冲突。
- 新增页面能力时先问：能不能用原生 DOM + `fetch` 完成？能就不要引依赖。

## 读路径 / 写路径

读路径：

- 只发 `GET`。
- 数据库访问只走 `asRole('keel_control')`，并且只发 `SELECT`。
- 只绑定 `127.0.0.1`，不做鉴权 —— 因此**不要**把它暴露到公网。

写路径只有一条，2026-11-04 加入：

- `POST /api/tasks/:id/decide`（`{decision: approve|reject|rework, note?}`）与
  `POST /api/tasks/:id/answer`（`{text}`）。它们**转调** `src/cli/decide.ts` 的
  `decideTask` / `answerTask` —— 和 `pnpm keel decide|answer` 同一个 driver、同一套预检，
  页面里不复制任何状态机逻辑。其余任何非 `GET` 方法仍然 `405`。
- 四道本机校验全过才放行（`writeRejection`）：`Host` 回环、`Origin`（浏览器带时）
  回环、`Content-Type: application/json`、`X-Keel-Console` 等于进程启动时随机生成、
  注入到页面 `<meta name="keel-console-token">` 的令牌。前两条挡 DNS rebinding，
  后两条靠 preflight 挡别的站点直接 fetch（我们对 `OPTIONS` 一律不回 CORS 头）。
  这是**挡住「某个网页顺手点一下」**，不是鉴权：本机能读到页面的人本来就能跑 CLI。
- 加写端点时**不要**放宽这四条，也不要把令牌写进常量：它必须是每次进程启动新生成的。
- `control_mode ≠ auto` 时不派发 —— 页面要把服务端返回的 `error` 原样显示出来，
  不要吞掉改写成「失败」。

人工闸门的 UI 形态：**决策页优先，按钮其次**。

- `S-HUMAN_REVIEW` / `S-NEED_CLARIFICATION` 时详情页多一个 `decision` Tab，并且是默认落点
  （`state.tabChosen` 为假时强制激活；用户亲手选过 Tab、或 hash 里带 `tab=` 就尊重用户）。
  其它状态不注入这个 Tab。
- 决策页的四块顺序固定：**为什么停在这里 → 证据 → 这次决定依赖的事实 → 选项**，澄清闸门把
  中间两块换成「在问什么 / 不回答会怎样」。数据全部来自已在手的 `d`（runs / events /
  artifacts / feedbacks / timers），**不新增接口、不新增表**；某块算不出来就整块不渲染，
  不写占位文案。
- 每个选项卡片写清**后果**（建分支并派发第几轮 / 回到方案讨论 / 进入终态），不可逆的那个
  放最后并标「终态 · 不可恢复」。理由用卡片内联 `<textarea>`，必填项为空时按钮 `disabled`；
  **不要用 `window.prompt` / `window.confirm`** —— 弹窗挡住了判断依据，也挡住了失败原因。
- 提交成功 / 失败都写在**对应卡片内部**（`.option-msg`），不弹全局提示。
- 选项文案是**承诺**：它与 `src/control/transition/table.ts` 的副作用一一对应
  （T-014 / T-016 / T-015 / T-007）。改转移表就要改文案；`console.test.ts` 断言页面里的
  选项 key 集合等于 `src/cli/decide.ts` 的 `DECISIONS`，别绕过它。
- 概览 Tab 顶部保留一条窄入口 `.human-callout`：「停在人工评审 · 去决策页」+ 等价 CLI 命令；
  **只在不在决策页时渲染**，决策页自己底部给等价命令（`.decision-cli`）。两侧都不放
  与决策页重复的一排按钮。

页面里给出的命令一律带 `pnpm ` 前缀（`pnpm keel …` / `pnpm run timeline -- …`）：
`keel` 只是 `package.json` 的 `bin` 声明，仓库里没有 `node_modules/.bin/keel`，
全局也没装。只写 `keel decide` 会让人复制到终端后撞 `command not found` ——
**页面上写什么，就得能原样跑起来**。

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

## 三种视图：概览 / 任务 / 项目

- 页面有三种视图，共用同一个侧栏骨架：**概览**回答「最近干得怎么样」，**任务**以 task 为主体，
  **项目**以仓库为主体。切换只改可见容器与按钮态（`applyModeChrome`），不要复制多套侧栏。
- 概览是默认落点（`state.mode` 的初值），因为它先回答最常见的问题；周期控件选的是「哪段时间」，
  与「看哪个任务」正交。
- 概览模式隐藏搜索框、项目下拉与状态 chip：它的列表是「全部任务、按更新时间」的原始顺序，
  点了就进任务模式 —— 这类筛选在概览里没有对应口径，留着只会让人以为筛选生效了。
- 项目由客户端按 `repo`（仓库地址）归组，**不是** `repo_id`：`repo` 表没有 remote_url 唯一约束，
  按 id 分会把同一项目拆成两行。聚合值（任务数、状态分布、轮次、成本）都从 `/api/tasks` 的
  现成字段算，不新增写路径、不新增聚合接口。
- 项目视图只做聚合与跳转：任务明细仍然回任务模式看，避免一个事实出现两种口径。

### 项目页：先回答「有没有事等我」，再给全量

- 页面目标是让人**少思考**：首屏只回答两个问题 —— 有没有事等我、项目整体怎么样。
  不要摆指标仪表盘；项目页不是报表。
- 侧栏项目项固定两行：
  - 第一行：项目短名 + 待处理徽章（仅当 `needsYou > 0`，文案 `2 待处理`）；
  - 第二行：`5 个任务 · 2 运行 · 1 完成 · 10-25 14:19`。
  - 完整 URL 只进 `title`；provider 不常驻；成本与秒级时间不进侧栏。
- `needsYou` 只数**能直接进决策页**的状态（`isGateStatus`：`S-HUMAN_REVIEW` /
  `S-NEED_CLARIFICATION`）。其余闸门态（`S-NEW` / `S-RFC_READY` / `S-PR_OPEN`）算「等待中」，
  不能把系统等待误报成人的待办。项目排序：`needsYou` 降序 → 最近更新降序。
- 项目详情头部只留三样：项目名（`title` 带完整 URL）、一句话现状、累计元信息行。
  一句话用白话，例如「2 个任务需要你处理，2 个在跑。」；没有进行中任务时明说
  「没有进行中的任务」。**不要**恢复 6 块指标带和状态分布图 —— 分组标题的计数已经表达同一事实。
- 任务按行动分组，顺序固定，空组整组不渲染：
  `需要你处理`（needs）→ `进行中`（stage）→ `等待中`（waiting）→ `已收尾`（terminal）。
  分组判定只在 `projectGroupOf` 一处。`需要你处理` 组行内给 `去决策 →` / `去回答 →`，
  点击仍走 `select(taskId)`（它会重置 `tabChosen`，闸门任务自动落到决策 Tab），
  **不要**在项目页复制决策逻辑。
- 列表列只保留状态 / 标题 / 更新时间；分支、单任务成本降层到任务详情。
  时间统一 `fmtListTime`（MM-DD HH:mm）；项目级成本用 `fmtCostShort`（≥ $0.01 时 2 位小数）。
- 口径差异要写在标签上：`待处理` = needs，`待介入` = needs + waiting。
  两个数字不同是正常的，但标签必须不同，不能让用户以为计数在撒谎。
- 模式与选中项进 URL Hash：`#mode=overview`、`#mode=projects&repo=<url>` 与 `#task=<id>&tab=<tab>`；
  只有 `task` 键的链接回落到任务模式。5s 轮询必须保持当前模式与选中项目。
- 侧栏的计数只写一处：状态计数长在筛选 chip 上（`.pill-n`），不要再造一排 KPI 方块重复表达。
- 筛选分两层，口径与位置必须一致：
  - 任务模式：项目用下拉（`.repo-filter`，仓库多时不要排 chip），状态用 chip，两者叠加；
  - 项目模式：项目下拉隐藏，状态 chip **移到任务列表上方**（`.proj-filters`），
    筛的是当前项目的任务表；工具栏写「显示 X / Y」，无命中时给一行空态。
    侧栏只保留项目搜索 —— chip 筛谁，就站在谁旁边，不要让侧栏 chip 看起来像在筛项目列表。
  - chip 计数跟随当前筛选口径（`filterScopeTasks`）：任务模式跟项目下拉、项目模式跟选中项目；
    否则会出现「chip 说 7 条、点下去 0 条」。
- 筛选状态不进 URL Hash（属于临时视图态），但切模式不能丢；5s 轮询重绘也不能丢。
- 项目下拉按签名（项目集合 + 计数）决定是否重建选项，避免轮询重置用户正在操作的下拉框。

## 概览：统计口径

- 数据只来自 `GET /api/stats`（`STATS_DAYS_SQL` / `STATS_TOTALS_SQL`，只读聚合），
  页面不自造第三套统计。改动口径时 SQL 与这里的定义必须一起改。
- 口径（`keel status` 对得上）：
  - **运行次数** = `run.started_at` 落在当天的 Run（成功 / 失败 / 取消都算）；
    `runs_ok` = `SUCCEEDED`，`runs_failed` = `FAILED|TIMEOUT`；
  - **完成任务** = `task.terminal_at` 落在当天且 `status = 'S-DONE'`；
  - **问题闭环** = 当天到达 `S-DONE` 的任务所关联的**去重** `feedback` 数；
  - **成本** = 当天启动的 Run 的 `cost_usd` 之和；`unavailable` 记 0，不臆造。
  - 日期边界用**数据库会话时区**（当前 Asia/Shanghai）的 00:00，前端不做二次换算。
- 周期默认「昨天」（`state.overviewPeriod`）：最常见的问题是「昨天跑了什么」。
  没有数据时不给空表格，给一句「最近一次运行在 X」让人知道上次是什么时候。
- 14 天柱状图（`.ov-day`）同时是周期选择器：点某一天 → 周期切成 `date:YYYY-MM-DD`；
  柱高按窗口内最大值归一，成功 / 失败分段堆叠，`title` 给出当天明细。
- 「进行中」与「项目」两块的数字都从已加载的 `/api/tasks` 现算，不新增聚合接口；
  行右侧的 `.ladder` 是主路径 10 段站位（`stageIndex`），它表达「走到第几步」，
  不要和状态徽章重复表达同一件事。

## 视觉纪律（本轮沉淀）

- 页面里**不放 emoji**：图标一律走 SVG 或纯文字。emoji 在不同系统字体下尺寸/基线漂移，
  和「发丝线 + 系统字体」的基调冲突。
- 不用卡片堆：分组靠 `border-top` 发丝线与留白；徽章只做底色不做彩色描边；
  表格 / 统计块去掉圆角与阴影。
- 机器码只作次要层级：驾驶模式显示「自动执行 / 人工驾驶 / 已暂停」，`control_mode: auto`
  这类原文放 `title`，不要直接铺在标题栏。
- 窄屏覆盖（`@media (max-width: 1024px)`）必须写在**全部组件规则之后**：
  同特异性的选择器只有排在后面才盖得住基础样式，写在文件中部会静默失效。
  窄屏下指标条挤成一行、隐藏阶段箭头让 10 段主路径一屏读完，别让它横向滚出半个格子。

## 浏览器验证的坑

- 用无头 Chrome 截图验证交互态时，页面 `document.visibilityState` 是 `hidden`，
  **CSS transition 不推进**：`getComputedStyle` 会一直返回动画起点值，看起来像
  「点了导航高亮没跟上」。截图脚本先注入 `*{transition:none!important;animation:none!important}`，
  再判断样式；不要因此去改 CSS。
- `Emulation.setDeviceMetricsOverride` 按 CDP 会话隔离，每个脚本开头都要重新设置，
  否则截图会掉进 ≤900px 布局。
- `Page.navigate` 到同 URL 不同 Hash 不会重载页面，用 `?v=<timestamp>` 强制刷新。

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
