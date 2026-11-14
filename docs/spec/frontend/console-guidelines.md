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
- 默认只绑定 `127.0.0.1`；`KEEL_CONSOLE_HOST=0.0.0.0` 可对外监听。
  **鉴权始终生效**（2026-11-04 起）：除 `/login`、`POST /api/login`、
  `POST /api/logout`、`/healthz` 外，所有路由先过会话闸门。没有「关掉鉴权」的开关。

写路径共用 CLI 与 Control Plane：

- `POST /api/tasks/:id/decide`（`{decision: approve|reject|rework, note?}`）与
  `POST /api/tasks/:id/answer`（`{text}`）。它们**转调** `src/cli/decide.ts` 的
  `decideTask` / `answerTask` —— 和 `pnpm keel decide|answer` 同一个 driver、同一套预检，
  页面里不复制任何状态机逻辑。其余任何非 `GET` 方法仍然 `405`。
- `POST /api/tasks/:id/control` 接受 `action: pause|resume|takeover`，可附
  `expected_mode` 防止旧页面动作作用到新模式；转调 `controlTask`，与 CLI
  `pause|resume|takeover` 共用控制表和事务。终态拒绝操作，接管要求执行已收尾。
  从 `human` 交还必须提交 `note`，经同一 Proposal 校验保存新版 A-State，保留已有事实。
  这个入口不声明人工阶段完成，也不合成 A-StageOutcome。
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
- 主动驾驶按钮在 Cockpit 头部按模式显示。点击后展开内联确认区，写明后果；
  人工交还在同一区填写交接说明。提交中锁住按钮，失败保留说明与原因，成功立即刷新。
  不使用浏览器原生确认框，不把「暂停」描述为中断正在执行的轮次。
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

## 鉴权与会话（2026-11-04 起）

- **没有无鉴权模式**。`createConsoleHandler` 的 `auth` 必填；测试也必须显式给口令
  （`withServer` 默认注入固定口令并先登录）。
- 口令来源：`KEEL_CONSOLE_PASSWORD`；未设置时每次启动随机生成并**打印到启动终端**。
  口令不下发页面、不写日志、不进事件。进程内只保存 scrypt 哈希，比较用 `timingSafeEqual`。
- 会话：进程内存表，Cookie `keel_console_session` 带 `HttpOnly`、`SameSite=Strict`、
  `Path=/`；默认 12h，勾选「保持登录」7d。退出即删，重启即失效。
  反代 HTTPS 时设 `KEEL_CONSOLE_SECURE_COOKIE=1` 给 Cookie 加 `Secure`。
- 登录限流：每 IP 5 次 / 5 分钟，全局 20 次 / 5 分钟；超限 `429` + `Retry-After`。
  失败文案统一为「口令不正确」，不泄露口令是否存在。
- 公开路径清单只有一个来源（`console.ts` 的 handler 顶部）：`/login`、
  `POST /api/login`、`POST /api/logout`、`/healthz`。**新增路由默认受保护**；
  要加公开路径，先证明它不返回任何事实，并在测试里断言匿名可达。
- `/healthz` 匿名只回 `{ok}`；错误详情与 `connectionString()` 仅登录后返回。
  不要把连接串回给未鉴权请求。
- 写入口的四道校验不因登录而取消：绑回环时 `Host` 必须回环；`Origin` 存在时必须与
  `Host` 同源；`Content-Type: application/json`；`X-Keel-Console` 等于进程随机令牌。
  会话 Cookie 是另一层，不是替代品。
- 页面侧：统一 `fetchJSON` 遇 `401` 跳 `/login`；顶栏「退出」调用 `POST /api/logout`。
  登录页是独立单文件（`console-login-page.ts`），不加载任何事实，配色与主页面
  `:root` 保持一致 —— 改主色时两处一起改。

## 数据口径必须与 CLI 一致

- 页面上的 task / run / event 必须能和 `keel status`、`pnpm run timeline -- <id>` 对上。
- 新增字段时先看 CLI 查询，避免出现两套事实口径。
- 状态集合与主路径来自代码（`src/shared/ids.ts`、`src/control/transition/table.ts`），
  不要在页面里手抄一份状态表。

### 只读字段范围（`src/cli/console.ts`）

- `GET /api/tasks`（列表）同时返回 `tasks` 与项目全集 `repos`。`tasks` 含
  `id, title, status, control_mode, risk, complexity, work_branch, base_branch,
  budget_usd, created_at, updated_at, terminal_at, repo_id, repo, repo_provider`，
  外加 `LEFT JOIN LATERAL` 聚合出来的 `run_count, total_cost_usd, total_tokens,
  event_count`（只读统计，不写回）。`repos` 直接读注册表，含
  `id, provider, repo, default_branch, local_path, created_at`；它是项目下拉与项目视图的
  全集，不能从「是否已有 task/workflow」反推。
- `GET /api/tasks/:id`（详情）：
  - `task`：列表字段 + `repo_id, current_run_id`；
  - `runs`：`id, stage, role, attempt, status, harness_id, harness_tier, session_ref,
    started_at, ended_at, error_kind, error_detail, tokens_in, tokens_out, cost_usd, cost_basis`；
    仅 `RUNNING` 的行 LEFT JOIN `run_liveness` 并附 `liveness`，字段为
    `last_progress_at, silence_threshold_ms, owner_heartbeat_at`。无遥测或非运行行返回 null，
    不暴露 PID、进程组或配置。沉默阈值使用已固化的 `silence_ms`，不按 stage 重算。
  - `events`：`seq, run_id, type, payload, trace_id, span_id, occurred_at`（按 `seq` 升序）；
  - `artifacts`：`id, kind, key, version, schema_version, produced_by_run, committed_at,
    committed_at_seq, superseded_by, body` —— 返回**全部版本**（`kind, key, version DESC`），
    由前端用 `superseded_by` 串成版本链，而不是在 SQL 里只挑最新版；
  - `feedbacks`：`task_feedback JOIN feedback` 取 `id, source, external_ref, body, received_at`；
  - `timers`：`id, run_id, kind, due_at, state, fired_at, created_at, updated_at`。
- 以上查询全部走 `asRole('keel_control')` 且只含 `SELECT`；新增字段时同步扩充
  `src/cli/console.test.ts` 里的注入式 `fakeQuery` 分支，保持可测。
- `GET /api/workflows` 保留 workflow 原始状态，附 `repo / repo_provider`、
  当前图的 `node_count / archived_count / waiting_human / failed_count / run_count`、
  `activity_at` 与 `tickets`。`tickets` 和详情 `nodes` 共用 `WORKFLOW_NODE_SELECT`：
  关联实际 `managed_ticket_task` 的 `ticket_status / current_stage / ticket_error`，
  当前 `pending_decision_id + pending_decision_revision` 的 `decision_status / decision_question`，
  以及最新 `managed_ticket_stage` 的阶段、状态、attempt、错误与起止时间。
  不以 graph 节点状态代替实际 ticket 进展。
- `run_count` 只数当前图所绑定 ticket 的 `managed_ticket_stage` 行（含重试与失败）；
  `node_count` 只数当前图节点，二者独立表达。API 字段缺失时显示「执行次数不可用」，
  不从节点数、workflow 调度 attempts 或默认零伪造执行次数。
- `last_progress_at` 只读当前 RUNNING ticket、当前 RUNNING stage 对应的
  `ManagedTicketProgress` 事件 `payload.observedAt`，按 `stageId` 排除上一轮遥测。
  没有事件显示「暂无进展信号」，不拿 owner 心跳或更新时间冒充执行进展。
  `activity_at` 合并节点、ticket、决策、阶段和进展事件的更新时间；列表排序、项目最近更新、
  详情时间与静默轮询指纹均包含这些进展，不依赖 workflow 顶层状态先同步。

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
- 时长文案统一走 `fmtDurationMs`：ms → s → `Nm Ns` → `Nh Nm` → `N 天 N 小时`（≥1 天换天），
  不要在各处自己拼单位。
- 「已停留」类实时文案在节点上带 `data-since` + `data-prefix`，由 `tickElapsed()` 在轮询节拍里
  单独刷新文本 —— 指纹未变时不会重绘 DOM，不这样写时长会冻住。
- Run 卡片与 Cockpit 的活跃度只以新进展判断。30 秒内为活跃，之后沉默，
  超过有效 `silence_threshold_ms` 才警告「可能卡死」；阈值 null 不报警，无信号不假装活跃。
  owner 心跳只作补充说明，不替代进展。详情指纹包含遥测，时长也由轮询节拍刷新；
  绿色脉冲仅用于活跃度，遵守 `prefers-reduced-motion`。

## 四种视图：概览 / 任务 / 项目 / 工作流

- 页面有四种视图，共用同一个侧栏骨架：**概览**回答「最近干得怎么样」，**任务**列真实工作项，
  **项目**以仓库为主体，**工作流**展示 managed workflow 的图和实际 ticket 进展。
  切换只改可见容器与按钮态（`applyModeChrome`），不要复制多套侧栏。
- 概览是默认落点（`state.mode` 的初值），因为它先回答最常见的问题；周期控件选的是「哪段时间」，
  与「看哪个任务」正交。
- 概览模式隐藏搜索框、项目下拉与状态 chip：它的列表是「全部任务、按更新时间」的原始顺序，
  点了就进任务模式 —— 这类筛选在概览里没有对应口径，留着只会让人以为筛选生效了。
- 后端事实保留四种身份：repo 定义项目，legacy task、managed ticket 是工作项，
  managed workflow 是容器与依赖图。状态机不同，不能为“整洁”把数据库或 API 合并。
- 客户端只有 `workItems()` 一个投影：它把 legacy task、managed ticket 和尚未物化 ticket 的
  workflow 统一成 `item_type = task | ticket | workflow` 的列表。`Project.items`、任务列表、
  概览进行中、项目卡片、状态栏和项目/概览计数全部消费这组列表，不再保留
  `taskRecords()` / `projectRecords()` 两套重复口径。
- 已经物化 ticket 的 workflow 只贡献真实 ticket，不能把整个容器折成一条任务；零 ticket 的
  workflow 保留为 `item_type=workflow` 的规划项，否则 ROUTING / READY 等调度事实会从所有
  工作项视图消失。`recordKind / recordNeedsHuman / recordBadge` 按 `item_type` 集中分类；
  **禁止把 workflow 伪装成 `S-*`**。
  分类以真实 ticket 为准：ticket RUNNING 或决策 PROCESSING 算活跃，即使 workflow 仍为 READY；
  decision PROCESSING 显示「天问处理中」；有 ticket 但没有实际活跃 ticket/决策时归入等待，
  人工待办优先分组。图尚无 ticket 时展示 workflow 自身的规划/调度状态。
- 项目由客户端按 `repo`（仓库地址）归组，**不是** `repo_id`：`repo` 表没有 remote_url 唯一约束，
  按 id 分会把同一项目拆成两行。项目全集来自 `/api/tasks` 返回的 `repos`；先用仓库建立
  `Project`，再把工作项附到 `items`。没有任务的已注册仓库因此天然是空 `items`，**不得**
  再合成 `repository_only` 伪任务来让项目出现。工作项找不到注册仓库时仍要建立项目，
  保证异常旧数据不被静默丢弃。聚合只消费 `/api/tasks`、`/api/workflows` 的现成字段。
  项目视图只做聚合与跳转：legacy 明细回任务模式，managed 明细回工作流模式。
- 所有模式的首次加载、切入概览/项目/工作流、手动刷新与 5s 轮询，都经 `loadRecords`
  同时获取两类记录，落定后统一绘制。不得让概览只加载 legacy，或等用户先访问工作流页才补齐项目。
  任一路记录加载失败都保留其上次成功记录，并在共享视图和状态栏标明未同步；
  工作流侧栏也显示该路错误，不把部分同步报成全部成功。
  历史统计失败也不能遮住当前记录。刷新保持模式、选中项目和临时筛选。

### 项目页：先回答「有没有事等我」，再给全量

- 页面目标是让人**少思考**：首屏只回答两个问题 —— 有没有事等我、项目整体怎么样。
  不要摆指标仪表盘；项目页不是报表。
- 侧栏项目项固定两行：
  - 第一行：项目短名 + 待处理徽章（仅当 `needsYou > 0`，文案 `2 待处理`）；
  - 第二行：`5 个任务，2 个在跑，1 个完成`，时间单独右对齐一列（`projectFacts` / `projectSubline`）。
  - 完整 URL 只进 `title`；provider 不常驻；成本与秒级时间不进侧栏。
- legacy 的 `needsYou` 只数**能直接进决策页**的状态（`isGateStatus`：`S-HUMAN_REVIEW` /
  `S-NEED_CLARIFICATION`）；managed 只看当前 ticket 的真实人工等待。
  活跃请求为 `PROCESSING`（天问处理中）或 `OPEN` 时不算人的待办，`WAITING_HUMAN` 才算；
  没有当前决策请求时按 ticket 的 `WAITING_HUMAN` 判断。一个 workflow 有多个待办 ticket 时，
  项目页逐个计数；工作流侧栏仍单列待办节点数。
  其余等待态不能误报成人的待办。项目排序：`needsYou` 降序 → 最近更新降序。
- 项目详情头部只留三样：项目名（`title` 带完整 URL）、一句话现状、累计元信息行。
  一句话用白话，例如「2 个任务需要你处理，2 个在跑。」；没有进行中任务时明说
  「没有进行中的任务」。按 #127 在项目侧栏和详情头部加入一条阶段分布堆叠条，
  从全部项目任务按 `status` 聚合；颜色复用 move/signal/good/bad，悬停或键盘聚焦
  读取各状态任务数。摘要的「活跃」= 所有非终态，「待处理」仍只数人工闸门。
  临时任务筛选不改变项目整体分布。窄屏保持整条缩放、摘要换行，不恢复指标方块。
- 任务按行动分组，顺序固定，空组整组不渲染：
  `需要你处理`（needs）→ `进行中`（stage）→ `等待中`（waiting）→ `已收尾`（terminal）。
  分组判定只在 `projectGroupOf(record)` 一处。`需要你处理` 组 legacy 行内给 `去决策` / `去回答`（不带箭头），
  点击仍走 `select(taskId)`（它会重置 `tabChosen`，闸门任务自动落到决策 Tab），
  managed 行只给「查看工作流」，并展示 ticket、当前阶段、阻塞原因和最近更新；
  **不要**在项目页复制决策逻辑。
- 列表列只保留状态 / 标题 / 更新时间；分支、单任务成本降层到任务详情。
  时间统一 `fmtListTime`（MM-DD HH:mm）；项目级成本用 `fmtCostShort`（≥ $0.01 时 2 位小数）。
- 口径差异要写在标签上：`待处理` = needs，`等待 / 待处理` = needs + waiting。
  两个数字不同是正常的，但标签必须不同，不能让用户以为计数在撒谎。
- 模式与选中项进 URL Hash：`#mode=overview`、`#mode=projects&repo=<url>` 与 `#task=<id>&tab=<tab>`；
  只有 `task` 键的链接回落到任务模式。5s 轮询必须保持当前模式与选中项目。
- 侧栏的计数只写一处：状态计数长在筛选 chip 上（`.pill-n`），不要再造一排 KPI 方块重复表达。
- 筛选分两层，口径与位置必须一致：
  - 任务模式：项目用下拉（`.repo-filter`，仓库多时不要排 chip），状态用 chip，两者叠加；
  - 项目模式：项目下拉隐藏，状态 chip **移到任务列表上方**（`.proj-filters`），
    筛的是当前项目的任务表；工具栏写「显示 X / Y」，无命中时给一行空态。
    侧栏只保留项目搜索 —— chip 筛谁，就站在谁旁边，不要让侧栏 chip 看起来像在筛项目列表。
  - chip 计数跟随当前筛选口径（`filterScopeItems`）：任务模式跟项目下拉、项目模式跟选中项目；
    否则会出现「chip 说 7 条、点下去 0 条」。
- 筛选状态不进 URL Hash（属于临时视图态），但切模式不能丢；5s 轮询重绘也不能丢。
- 项目下拉按签名（项目集合 + 计数）决定是否重建选项，避免轮询重置用户正在操作的下拉框。

## 概览：统计口径

- 历史统计只来自 `GET /api/stats`（`STATS_DAYS_SQL` / `STATS_TOTALS_SQL`，只读聚合），
  范围为 legacy tasks/runs，页面标注「历史统计（旧版任务）」。
  当前进行中、项目与状态栏另按 `workItems()` 表达，不把 managed 节点混进 legacy Run 统计。
  改动统计口径时 SQL 与这里的定义必须一起改。
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

## 视觉系统：海图仪表

**墨色表示位置，颜色表示要不要你动手。** 这是整套长相的唯一判据：改样式前先问
「这个颜色在回答需不需要人，还是只是装饰」，后者一律退回墨色。

### 颜色

| token | 明 | 暗 | 用途 |
|---|---|---|---|
| `--paper` / `--panel` / `--panel-2` | `#EDF0F2` / `#F8F9FA` / `#FFFFFF` | `#10161B` / `#151C21` / `#1A2228` | 侧栏底 / 内容面 / 浮起小块 |
| `--ink` / `--ink-2` / `--ink-3` | `#12181D` / `#3E4A52` / `#64707A` | `#E7EDF1` / `#B3BFC7` / `#7F8C95` | 正文 / 次级 / 元信息 |
| `--signal` | `#A65A00` | `#E0A05C` | 需要你（页面唯一的暖色） |
| `--move` | `#1F5E7A` | `#74A9C7` | 进行中 |
| `--good` | `#2C6B4F` | `#6FAF8C` | 已收尾 |
| `--bad` | `#8E2F2B` | `#D97A72` | 异常 / 终态不可恢复 |
| `--special` | `#5B4B8A` | `#A99BD0` | harness、版本等附属标记 |

- 颜色只以两种形态出现：**2px 竖线 / 横线**（标记「这里」）与 **7px 方块**（标记状态）。
  不再有填充胶囊、浅色底徽章、彩色描边、彩色文字按钮。
- `*-wash`（8% 明 / 14% 暗）只给整块提示（人工闸门 callout），不进徽章、不进表格行。
- 禁用 macOS 系统色（`#0a7aff` / `#ff9f0a` / `#30d158` / `#ff453a` / `#f5f5f7`）：
  那是「默认皮肤」的指纹，`console.test.ts` 已断言它们不存在。
- 对比度下限 4.5:1（对 `--panel`）：signal 4.9、move 7.2、good 6.1、bad 7.8、ink-3 4.8。

### 字体

```
--sans: "Avenir Next", "Avenir", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
--mono: "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
```

- **等宽只给机器事实**：ID、分支、命令、JSON、diff、事件码。正文、数字、元信息一律 Avenir +
  `font-variant-numeric: tabular-nums`。这是最容易被破坏的一条 —— 顺手给数字套 `--mono`，
  整页就退回「终端截图」的气质。
- 层级：品牌 11px/600/字距 .16em；页标题 19px/600；摘要 13.5px；列表 12.5px；元信息 11px；机器码 10.5px。
- 不用全大写英文 eyebrow、不用 `WORD — fragment` 式标签、不用 `A · B · C` 拼接。

### 状态标记

- `.badge` = 7px 方块（`.dot`）+ 12px 中文（`.badge-zh`）+ 10.5px 机器码（`.badge-code`）。
  颜色只上在方块上，文字保持墨色；没有底色、没有圆角、没有脉冲动画。
- Run 状态同构复用 `.badge`（`runStatusBadge` + `_runStatusLabels`），不要另起一套纯英文标签。
- 颜色不是唯一信息：方块旁永远有中文，`title` 给出机器码。
- 驾驶模式显示「自动执行 / 人工驾驶 / 已暂停」，`control_mode: auto` 这类原文放 `title`。

### 位置刻度 `.ladder`

- 10 段主路径 = 10 个 4×8px 无圆角小列，间距 3px；已走 `--ink-3` 40%，当前 `--ink`，
  闸门当前段 `--signal`，异常 `--bad`，走完 `--good`。`title` 给「主路径第 N / 10 段」。
- 项目行、概览「进行中」行都带刻度；≤1024px 隐藏（宽度让给详情）。

### 状态机轨迹

- 10 段主路径读成**一把刻度尺**：每段一条 2px 基线，基线填充比例是停留时长（`durationPct`）；
  当前段在刻度上方压一条 2px 墨线当游标，偏离主路径时游标压在分出站并转 `--signal`。
- 不做 10 个等重卡片；也不要用节点宽度编码时长 —— 会被 `min-width` 压平。
- 每段三行：段名 → 时长 / 状态（`已通过` / `6.2s` / `已跳过` / `分出 35m 46s`）→ 基线。
- `overflow-x: auto` 会连带裁掉纵向 `::before`：游标要么放进 `padding-top`，要么别用负偏移。

### 文案

- 元信息用中文逗号成句：`5 个任务，21 轮，累计 $1.68，11-04 14:19 更新`。
- 机器字段在页面上说人话：`estimated` → `估算`，`SUCCEEDED` → `成功`；
  但**证据区**（事件 payload、错误类型、转移编号）保留原文，那是事实。
- CTA 去掉箭头：`去决策` / `去回答`。状态机里的 `A → B`、`/` 分隔保持原样 ——
  那是事实方向，不是装饰。
- 页面里**不放 emoji**：图标一律走 SVG 或纯文字。emoji 在不同系统字体下尺寸 / 基线漂移，
  和「发丝线 + 系统字体」的基调冲突。

### 响应式

- ≤1024px：侧栏 260px，隐藏 `.ladder`，决策选项单列，阶段箭头去掉让 10 段一屏读完。
- ≤900px：三块纵向排队（侧栏 → 详情 → 状态栏）。`#app` 用
  `grid-template-rows: auto auto auto`，状态栏最小高度 26px、内容允许换行；
  列用 `minmax(0, 1fr)`，详情设置 `min-width: 0`，避免长内容撑宽整页。
  **必须显式给 `aside` / `main` / `.statusbar`
  指定 `grid-row`** —— `.statusbar` 基础样式里写死了 `grid-row: 2`，不覆盖就会插在侧栏和详情中间。
- 窄屏覆盖（`@media (max-width: 1024px)`）必须写在**全部组件规则之后**：
  同特异性的选择器只有排在后面才盖得住基础样式，写在文件中部会静默失效。

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
