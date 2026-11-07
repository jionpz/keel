# 设计：人工闸门决策页

## 边界

- **只重排已有事实**。不新增接口、不新增表、不新增写路径；数据只来自
  `GET /api/tasks/:id` 已返回的 `task / runs / events / artifacts / feedbacks / timers`。
- **不复制状态机**。选项的后果文案是**文案**，但它描述的副作用必须与
  `src/control/transition/table.ts` 对得上；改表时这段文案要一起改（见「漂移风险」）。
- **写入口不变**：`POST /api/tasks/:id/decide|answer` 原样复用，页面只是换了调用它的界面。

## 页面结构

新增第五个 Tab `decision`，仅在 `S-HUMAN_REVIEW` / `S-NEED_CLARIFICATION` 时存在，
且这两个状态下作为**默认激活** Tab（`state.activeTab` 的初值与 hash 回落都走它）。

```
┌ 决策 ────────────────────────────────────────────────────────────┐
│ 为什么停在这里                                                     │
│   一句话 + 机器码（次要） · 已停留 9天20h · 已花 $0.09 / 预算 $5    │
│                                                                   │
│ 证据                                                              │
│   ┌ 触发：develop #3 TIMEOUT（RUN_TIMEOUT）                        │
│   │   detail: …（有就显示，无则省略）                                │
│   ├ 同阶段轨迹： #1 SUCCEEDED 21.6s / #2 FAILED PROTOCOL_ERROR …   │
│   │              #3 TIMEOUT RUN_TIMEOUT — 已达 max_attempts        │
│   └ 结论：该阶段重试额度已用尽，T-031 转人工                          │
│                                                                   │
│ 这次决定依赖的事实                                                 │
│   分支 ai/task-5ec1ada9 → main                                     │
│   RFC v1《在 README.md 末尾新增 Usage 小节》   [查看全文]            │
│   变更 1 个文件 · 最近成功 develop #1                              │
│                                                                   │
│ 选项                                                              │
│   ┌ 批准 ──────────┐ ┌ 返工 ──────────┐ ┌ 驳回 ──────────┐        │
│   │ 创建分支并派发  │ │ 回到方案讨论，  │ │ 进入终态，      │        │
│   │ develop 第 4 轮 │ │ RFC 将被重写    │ │ 不可恢复        │        │
│   │ [理由(可选)]    │ │ [理由(必填)]    │ │ [理由(必填)]    │        │
│   │ [批准]          │ │ [要求返工]      │ │ [驳回]          │        │
│   └────────────────┘ └────────────────┘ └────────────────┘        │
│   ⚠ 状态在预检之后被并发改变时，会原样显示服务端错误                  │
│                                                                   │
│ 已发生的裁决                                                       │
│   10-25 18:20 要求返工 · 理由「README 里已有的安装说明要复用」        │
└───────────────────────────────────────────────────────────────────┘
```

澄清闸门同骨架，把「证据 / 事实 / 选项」换成：

- 为什么在等：PM `verdict=unclear` 的 `reason`；
- 在问什么：`unresolved_questions`（有则列，无则省略）；原始需求正文（feedback body）；
- 不回答会怎样：TTL 剩余 `Xh Ym` → 超时进入 `S-ABANDONED`；
- 选项：一个多行输入 + 「提交澄清」。

## 数据映射

| 区块 | 来源 | 说明 |
|---|---|---|
| 停住原因一句话 | 现有 `findGateOrFailureReason(d, lastSev)` | 复用，但把它从 `branch-callout` 提升为决策页第一块 |
| 触发升级的 Run | `runs` 中 `status ∈ FAILED/TIMEOUT/error_kind` 的**最后一条** | 显示 stage / attempt / status / error_kind / error_detail / 耗时 |
| 同阶段轨迹 | `runs` 按 `stage` 过滤后按 `attempt` 升序 | 只在 >1 条时渲染；每条一行：`#attempt status error_kind 耗时` |
| 重试额度是否耗尽 | 轨迹里失败条数 vs 该阶段最大 attempt | 文案用「已达重试上限」而非断言具体数字；数字从轨迹算 |
| 已停留 | `traj.currentSince`（已有） | 复用 `tickElapsed` 的 `data-since` 机制，不新增定时器 |
| 预算 | `task.budget_usd` + 各 run `cost_usd` 之和 | 预算为空则只显示已花，不显示百分比 |
| 分支 | `task.work_branch` / `task.base_branch` | 缺失时整行不渲染 |
| 产物 | `artifacts` 最新一版 `kind`：`rfc` / `policy_decision` | 摘要取 `body.summary` 或标题首行；入口切到「概览与方案」Tab |
| diff 规模 | 最近 `WorkspaceDiffCollected` 的 `files_changed.length` | 没有就省略 |
| 澄清问题 | `artifacts` 中 `stage=pm` 的 outcome（`verdict`+`reason`）、`unresolved_questions` | 没有问题列表时不显示「问题」小标题 |
| 澄清 TTL | `timers` 中 `kind=clarification_ttl && state=PENDING` 的 `due_at` | 剩余 = `due_at - now`，负值显示「已到期，等待收割」 |
| 原始需求 | `feedbacks`（已有） | 取最近一条 `source=manual` 或 `github_issue` 的 body |
| 已发生的裁决 | `events` 中 `type=HumanDecision`，按 `seq` 倒序 | `payload.decision` → 中文；`payload.note` 原样显示 |

任何一项算不出来（字段缺失 / 数组为空）→ **整块不渲染**，不写占位文案。

## 选项模型

页面里用一张声明式表驱动三张卡，避免文案散落在 if/else 里：

```js
var DECISION_OPTIONS = {
  approve: {
    title: '批准',
    effect: '创建分支 {branch} 并派发 develop 第 {nextAttempt} 轮',
    irreversible: false,
    note: 'optional',
    cta: '批准'
  },
  rework: { title: '返工', effect: '回到方案讨论，RFC 将被重写', note: 'required', cta: '要求返工' },
  reject: { title: '驳回', effect: '进入终态 S-REJECTED，不可恢复', irreversible: true, note: 'required', cta: '驳回' }
}
```

- `{branch}` 取 `task.work_branch`（approve 会复用已存在分支）；
- `{nextAttempt}` = 该任务 `stage='develop'` 的 run 数 + 1，算不出就退化成「下一轮开发」；
- `note: 'required'` 时按钮在输入为空时禁用（`disabled`），不靠事后报错。

卡片顺序：**批准 → 返工 → 驳回**。把不可逆的那个放最后，且视觉上是唯一的破坏性按钮（`--bad` 描边）。

## 交互

- 理由输入：`<textarea>` 内联，`approve` 可选、其余必填；
- 提交：沿用 `submitAction(taskId, path, payload)`，增加 `busy` 态（按钮 `disabled` + 卡片 `aria-busy`）；
- 成功：卡片区替换为「已提交：S-HUMAN_REVIEW → S-DEVELOPING，正在刷新…」，随后 `refreshAll(true)`；
- 失败：在**对应卡片内部**显示服务端 `error` 原文，按钮恢复可点；
- 键盘：`Tab` 可达，`Enter` 在单行输入内提交、在 `textarea` 内换行（不拦截）。

## 代码落点

| 文件 | 改动 |
|---|---|
| `src/cli/console-page.ts` | 新增 `renderDecisionTab(d)` 与 4 个纯函数（`decisionEvidence` / `decisionFacts` / `decisionOptions` / `humanDecisions`）；`renderDetail` 的 Tab 列表按状态注入 `decision`；删除 `renderHumanCallout` 里的按钮逻辑，改为「跳转决策 Tab」的窄条（保留在概览 Tab 顶部作入口） |
| `src/cli/console-page.ts`（CSS） | 决策页样式沿用现有变量：发丝线分块、`--gate-soft` 只用于「为什么停在这里」、破坏性按钮用 `--bad` |
| `src/cli/console.test.ts` | 断言：闸门状态下 HTML 含决策页骨架与三种副作用文案；非闸门状态不含；页面源码不含 `window.prompt(` |
| spec `frontend/console-guidelines.md` | 记下「闸门状态默认落在决策 Tab」「选项文案必须与转移表副作用对齐」 |

## 漂移风险与对策

- **文案与转移表脱节**：`table.ts` 改了副作用而决策页文案没改，人会按错误的预期做决定。
  对策：`console.test.ts` 断言 `DECISION_OPTIONS` 的三个 key 与 `src/cli/decide.ts` 的 `DECISIONS` 完全相等；
  文案里的关键动词（`CreateBranch` / `nextRun('develop')` / `nextRun('brainstorm')`）在源码注释里点名对应转移 id，
  改表时能被 `check:transitions` 相关阅读路径带出来。
- **页面变慢**：决策页只做内存里的重排，不新增请求；轨迹与产物都来自已在手的 `d`。
- **窄屏**：三张卡在 `≤1024px` 堆成一列，副作用文案在前、输入在后。

## 回滚

纯前端渲染改动，回滚 = 回退 `console-page.ts` 一个文件；写端点、CLI、状态机均不受影响。
