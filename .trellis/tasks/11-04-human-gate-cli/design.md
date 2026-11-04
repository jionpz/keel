# 设计：人工介入入口（keel decide / keel answer）

## 1. 边界

本任务只做**入口**：让已经存在的转移（T-014 / T-015 / T-016 / T-007）第一次被真实发出。
状态机、转移表、Fact Plane 读模型都不改。

明确不做：

- 控制台开写路径（它仍是 `keel_control` + 只读 + 非 GET 405）。
- `control_mode` 的入口（C-003 接管 / C-005 恢复 / C-006 交还）—— 见 §10 已知缺口。
- 任何通知渠道。

## 2. 命令契约

```
keel decide <taskId> approve|reject|rework [--note <text>]
keel answer <taskId> --text <text>
```

| 命令 | 前置 status | TransitionEvent | 转移 |
|---|---|---|---|
| `decide approve` | `S-HUMAN_REVIEW` | `HumanApproved` | T-014 → `S-DEVELOPING` |
| `decide reject` | `S-HUMAN_REVIEW` | `HumanRejected` | T-015 → `S-REJECTED` |
| `decide rework` | `S-HUMAN_REVIEW` | `HumanRequestedRework` | T-016 → `S-BRAINSTORM` |
| `answer` | `S-NEED_CLARIFICATION` | `ClarificationReceived` | T-007 → `S-PM_ANALYZING` |

**前置校验在写入之前**：先以 `keel_control` 读一次 `(status, control_mode)`。

- status 不匹配 → 打印当前状态 + 可用动作 + 下一步命令，`exitCode = 1`，**零写入**。
- `control_mode ≠ auto` → 同样的处理，并说明原因（`paused`：预算熔断；`human`：人工接管中，
  控制平面按设计不派发，恢复需 C-006 交还 —— 而该入口目前也不存在，如实说）。
  理由：`transition()` 对 `ignoresControlMode: false` 的规则在非 auto 下一律拒绝，
  不预检就会写一条 `NoTransition` 事件 —— 用户看到「什么都没做但库里多了东西」。
- 预检之后仍可能出现**竞争**（预检到 advance 之间状态被改）：此时 `advance` 返回
  `advanced:false`，命令如实转述 `reason` 并以非 0 退出。这次 `NoTransition` 是
  真实发生的事实，留着是对的。

退出码约定与现有命令一致：`0` 成功；`1` 业务拒绝 / 前置不满足；`2` 用法错误。

## 3. 跨角色写入：为什么 `answer` 是两段

`feedback` 的写权限只在 `keel_ingress`（`migrations/…_initial-schema.sql` §写权限矩阵），
`keel_control` 对它只有 `SELECT`；而 `src/fact/invariants.test.ts:269` 的
「keel_control 不能 INSERT feedback」正锚着这一点。`SET LOCAL ROLE` 是**事务级**的，
一个事务不可能既是 ingress 又是 control。

三个候选：

| 方案 | 部件数 | 代价 |
|---|---|---|
| A 两段写（选定） | 0 个新 DB 对象 | feedback 先落、control 事务后落；中间失败会留一条未引用的 feedback |
| B 给 `keel_control` 加 `INSERT ON feedback` | 1 行 GRANT | 拆掉 I6 的反例测试；控制平面此后能凭空造外部输入 |
| C `SECURITY DEFINER` 函数（仿 `keel_commit_artifact`） | 迁移 + plpgsql + GRANT + `advance` 抽出事务内变体 | 为了原子性引入一层新 DB 对象，且仍要改 driver |

选 A。理由：

- 需要原子的是**状态 / 事件 / run / link**（I4：状态变更必伴随事件），这四样全在
  `keel_control` 事务内，A 不削弱它。
- 失败窗口只剩「feedback 已写、advance 未跑」。留下的是一条 append-only、无人引用的
  feedback 行（I6 本来就要求 feedback 不可改不可删），不污染任何读模型 —— 控制台
  `feedbacks` 是按 `task_feedback` JOIN 出来的，未关联的行不会显示在任务下。
  命令会在错误里给出该 feedback id，用户看得见、可复核。
- B 用**安全边界**换取代码简洁，方向错了；C 用**新机制**换取一个只影响一条孤儿行的窗口，
  奥卡姆剃刀不划算。

B 的两段顺序：先 ingress 写 feedback，再 control 一次事务完成其余。

```
asRole('keel_ingress'): INSERT INTO feedback (source='manual', external_ref='clarification:<taskId>:<uuid>')
asRole('keel_control'): advance(taskId, {type:'ClarificationReceived', feedbackId}, now, {note?})
                        └ 同事务：task_feedback 链接 / 取消澄清 timer / 建 run(pm,n+1) / TaskStatusChanged
```

`external_ref` 用每次生成的新 uuid：同一个 task 可能被澄清多轮，不能用
`clarification:<taskId>` 当幂等键（第二次会被 `ON CONFLICT DO NOTHING` 吞掉）。
幂等性由预检 + 「同事务的事件流」保证，而不是靠这个唯一键。

## 4. `LinkFeedback` 从「记意图」变成真落地

T-007 现在发 `LinkFeedback`，而 `effects.ts` 把它归到 `recordIntent()` ——
写一条「已记录意图，尚未落地」，然后什么都没做。这条路径此前无人触发，
所以缺陷没暴露；本任务一旦触发它，「回答了澄清但任务下看不到回答」就会立刻被看见。

改法（最小）：

1. `TransitionEvent` 的 `ClarificationReceived` 增加可选字段 `feedbackId?: string`。
   其余事件不变；不带该字段时行为完全不变（`e2e/timer.test.ts` 现有调用仍是 intent）。
2. `effects.ts` 的 `LinkFeedback` 分支：事件带 `feedbackId` 时
   `INSERT INTO task_feedback (task_id, feedback_id) VALUES (…) ON CONFLICT DO NOTHING`
   → `SideEffectApplied {kind:'LinkFeedback', feedback_id, dedupe_key}`；
   不带时维持 `recordIntent()`，不假装做过。
3. T-001 不经 `applyEffects`（`driver.intake` 自己落 `SideEffectApplied`），因此不受影响。

## 5. `--note` 怎么落库

`advance(taskId, event, now, opts?: { note?: string })`：第 4 参可选，保持所有现有调用不变。
成功转移后，若 `opts.note` 非空，在**同一事务内**、`TaskStatusChanged` 之后再写一条
`HumanDecision` 事件，`payload = { decision: event.type, note }`。

- 选它而不是新开一个 `recordDecision()` 事务：备注与转移是同一件事，分开写就有
  「迁移成功、备注丢失」的中间态；而这次写入本来就在 driver 手上。
- 选它而不是塞进 `TaskStatusChanged` 的 payload：事件流按类型可读，`keel status`
  与控制台时间线都能把它单独渲染成一行；不给状态变更事件掺注释。
- `note` 不进 prompt、不参与 guard，只是给人看的记录（PRD 备注）。

`console.ts` 的 `EVENT_LABELS` 增 `HumanDecision: '人工裁决'`。

## 6. `approve` 需要真实工作区

T-014 的副作用是 `CreateBranch` + `nextRun('develop')`。不注入 workspace 时
`createBranch()` 退回意图 → **分支不会真的建出来**，之后 `keel run-task` 驱动
develop 时没有 worktree。

因此 `decide approve` 必须拿到与 `run-task` 相同的绑定。把 `run-task.ts:290-318`
（读 task+repo → `GitWorkspace.prepareProject` → `WorkspaceBinding`）抽成
`src/cli/task-workspace.ts` 的 `loadTaskWorkspace(taskId)`，由 `run-task` 与 `decide` 共用。

- 只 `approve` 走这段（`reject` 无副作用，`rework` 只需要建 brainstorm run，不碰工作区）。
- 与 run-task 的语义差异：run-task 之后还要驱动；`decide` 只做一次转移，
  然后打印 `keel run-task <taskId>` 作为下一步。

## 7. 控制台提示条（只读）

任务详情页在 `status ∈ {S-HUMAN_REVIEW, S-NEED_CLARIFICATION}` 时，在标题区下方渲染
一条 `.human-callout`：

```
需要人工：<状态中文名> —— 当前 <已停留时长>
keel decide 1d89… approve                     [复制]
keel decide 1d89… reject --note "…"           [复制]
keel decide 1d89… rework                      [复制]
```

`S-NEED_CLARIFICATION` 时只给 `keel answer <id> --text "…"` 一条。

- 复用现有 `copy-btn`（只 `navigator.clipboard`，不发请求），因此**不新增写路径**；
  `POST` 仍 405（`console.test.ts` 已有该用例）。
- 命令文本在页面里拼（id 已知、状态已知），不新增 API 字段。
- 文案纪律：先事实（在等人 / 等澄清），再可执行命令；不放 emoji；
  幂等点击（复制按钮不改变任何状态）。

## 8. 失败文案矩阵

| 场景 | 输出 | 退出码 |
|---|---|---|
| status 不匹配 | 当前状态 + 该状态可用的命令（终态时明说 I8） | 1 |
| `control_mode=paused` | 「预算熔断已暂停，控制平面不派发」+ 累计成本/预算（能读到才写） | 1 |
| `control_mode=human` | 「人工接管中，控制平面按设计不派发；交还入口尚未提供」 | 1 |
| advance 竞争失败 | `reason` 原文 + 「状态已被并发改变，请重新读取」 | 1 |
| decide 成功 | `T-014 S-HUMAN_REVIEW → S-DEVELOPING`，effects 摘要，下一步 `keel run-task <id>` | 0 |
| answer 缺 `--text` | 用法提示 | 2 |
| workspace 准备失败 | 原样转述 `prepareProject` 的错误 | 1 |

## 9. 兼容性与回滚

- 只新增命令，不改既有命令行为；`advance` 第 4 参可选，`ClarificationReceived`
  新增字段可选 —— 现有调用与测试的语义不变。
- 事件类型 `HumanDecision` 是 `event.type text` 的自由取值，不需迁移。
- 不需要迁移、不需要回滚脚本。若 `LinkFeedback` 的真实实现出问题，
  回退 `effects.ts` 一个分支即可，事件流仍可读（此前是 intent）。

## 10. 已知缺口（不在本任务）

- `control_mode` 无入口：`paused`（预算熔断）与 `human`（接管）都没有恢复命令，
  用户只能在数据库层面改。C-003 / C-005 / C-006 需要另一个任务。
- 控制台仍不能直接操作；若日后要开，需要先解决「无鉴权本地页面 + 写路径」的信任模型。
- 澄清答复目前是「一次性文本」；多轮追问要靠 `feedback` 累积，没有会话式交互。

## 11. 测试策略

- `src/cli/decide.test.ts`（新）：用注入的 `WorkflowDriver` 假实现覆盖
  前置校验分支（零写入断言）+ 三个决定各自发出的 event + `--note` 落 `HumanDecision`。
- `src/control/driver/effects.test.ts`（改）：`ClarificationReceived` 不带 `feedbackId`
  仍记 intent；带 `feedbackId` 时写 `task_feedback` 且发 `SideEffectApplied`。
- `src/e2e/timer.test.ts`（改）：把「直接 advance 模拟人工回答」改成经
  `answer` 命令主体，覆盖 feedback 落库 + link + timer 取消 + 新 run 的整链。
- `src/cli/console.test.ts`（改）：页面含 `human-callout` 与 `keel decide` 文案；
  详情接口形状不变。
- 真实库由 `pnpm run check`（含 acceptance）与手工对账 `keel status` / 控制台验证。
