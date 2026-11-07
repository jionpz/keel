# 设计 · 编排停止原因可区分

## 1. 不变量

- **I1 合法停必须仍是成功**：设计内等待不能被报成故障，否则运维会学会无视这个退出码。
- **I2 故障不许静默**：编排器说「停了」时，必须同时说清「是等外部，还是卡住了」。
- **I3 判据只读既有事实**：不新增事件类型、不改 `run` 行、不写 `task`。
  停止原因是**本次调用的观察**，不是状态机的转移。
- **I4 只报告不修复**：判出卡住之后不做任何自动重派/回滚（`prd.md` R7）。

## 2. 判据：证据，不是状态分类

「当前状态是阶段态」不足以判定故障 —— 人工撤回（R-010）会把 run 标 `CANCELLED`
且不触发转移，此时阶段态**本来就**没有待执行 run。所以判据要读最近一次 run。

| 到达 `阶段态` 且 `PENDING run 为 null` | 结论 |
|---|---|
| 最近一次 run `CANCELLED` | 合法停 · `stopReason='cancelled'`（等人工恢复，C-005） |
| 最近一次 run `SUCCEEDED` / `FAILED` / `TIMEOUT`，但没有新 run | **故障**：转移本该建下一轮 |
| 最近一次 run `RUNNING` | **故障**：没人推进（单进程前提下） |
| 该 task 根本没有 run | **故障**：首次派发就丢了 |

`SUCCEEDED` 那一行正是 `firstRun` 撞键的指纹：run 成功 → 转移推进 → 副作用只记
`SideEffectSkipped` → 没有新 run。

非阶段态（`GATE_STATUSES`）走到同一分支时**只有** `S-HUMAN_REVIEW` 可能到达
（另外四个关口各有自己的分支，且都在此之前 return）→ `ok` + `stopReason='awaiting-human'`。
实现用 `switch` 穷举 `GATE_STATUSES`，默认分支不给「静默 ok」——
新增关口态时 TS 会要求在这里显式表态。

## 3. `stopReason` 的形状

```ts
export type StopReason =
  | 'terminal'            // 终态
  | 'paused'              // control_mode ≠ auto（预算熔断 / 人工接管）
  | 'awaiting-clarification'
  | 'awaiting-external-ci'
  | 'awaiting-human'      // S-HUMAN_REVIEW 等人审批
  | 'capability-denied'   // R4：能力请求被守卫拒绝，需要人工/外部
  | 'cancelled'           // R-010 人工撤回，等恢复
```

六个 `return ok(...)` 站点各自赋值，映射固定：

| 站点 | 条件 | `stopReason` |
|---|---|---|
| `loop.ts:128` 附近 | 终态 | `terminal` |
| `loop.ts:137` 附近 | `control_mode ≠ auto` | `paused` |
| `loop.ts:186` 附近 | 澄清态、TTL 未到期 | `awaiting-clarification` |
| `loop.ts:215` 附近 | `S-PR_OPEN` 且未注入 CI | `awaiting-external-ci` |
| `loop.ts:231` 附近 | 关口态（`S-HUMAN_REVIEW`） | `awaiting-human` |
| `loop.ts:296` 附近 | capability 被拒 | `capability-denied` |
| 新增 | 阶段态 + `CANCELLED` | `cancelled` |

字段是**必填**的：`ok` 不填就编译不过 —— 这是「以后新增停止路径忘了表态」的强制点。

## 4. 错误 kind：复用 `NOT_FOUND`，不新增 kind

候选：新增 `STALLED` / 复用 `PROTOCOL_ERROR` / 复用 `NOT_FOUND`。

- 新增 kind 要同时改 `src/contracts/errors.ts`（`ERROR_KINDS` + `RETRYABLE`）
  与 `docs/05-contracts/README.md` 的表格，spec 还写了「12 个 kind」的计数 ——
  三处同步，而本错误**从不落 `run.error_kind`**（它发生在 run 之外），
  收益只是日志里好看一点。
- 仓库里已有同类先例：`src/execution/session/manager.ts:66-72` 明确写了
  「CANCELLED 没有更贴切的 ErrorKind……需新增 ErrorKind（当前改动面/收益不匹配,不做）」，
  退而用 `PROTOCOL_ERROR`。这里沿用同一尺度。
- `PROTOCOL_ERROR` 的既有定义是「Harness 输出无法解析」，硬套会污染它的含义。
- `NOT_FOUND` 的定义是「查询的产物 / 事件不存在，重试不会让它出现」—— 本次就是
  **「本该存在的待执行 run 不存在」**，且 `retryable=false` 正是我们要的语义
  （对同一状态再跑一次，仍然没有 run）。

代价：`NOT_FOUND` 在本仓库也用于「找不到 task」，靠 `detail` 区分。可接受。

## 5. 为什么不在 `advance()` 里检测

转移执行器能看到「这轮没建 run」，但它看不到**为什么**该建：
`T-019`（回到 `S-DEVELOPING`）和 `T-017`（进 `S-QA`）都建 run，而 `T-013`（进
`S-HUMAN_REVIEW`）与 `T-021`（进 `S-PR_OPEN`）本就不建。把「建没建」写进
`advance` 的返回会逼每处转移声明「我该不该建」，等于把编排器的职责搬进控制平面。

编排器在**下一轮**读状态时天然拥有跨迭代的证据（状态 + 最近 run），
所以判据放这里最省。

## 6. CLI

`run-task` / `run-issue` 已经按 `result.ok` 决定退出码，故障 → 1 自动成立；
要改的只有成功路径的话术：

```ts
printRunResult(result.value)            // 增加一行 stopReason 的人话
if (result.value.finalStatus !== 'S-DONE') { …现状报告… }
```

`printRunResult` 打印 `stopped: <reason>（<中文说明>）`。保持 `finalStatus:` 行不动
（已有测试与验收脚本读它）。

## 7. 兼容与回滚

| 变化 | 兼容性 |
|---|---|
| `RunToCompletionResult.stopReason` 必填 | 源码内所有构造点都会编译报错 → 逐处补，不遗漏 |
| 阶段态返回 `err` 而不是 `ok` | **对外行为变化**，正是本任务的目的；依赖「卡住也算成功」的调用方（若有）会开始看到退出码 1 |
| 无 schema / 无迁移 / 无事件类型变化 | 回滚 = `git revert` 单次提交 |

## 8. 验证

| AC | 手段 |
|---|---|
| AC1 / AC6 | `src/control/orchestrator/` 新测试：直接种 `task` 状态 + `run` 行，调 `runTaskToCompletion` |
| AC2 | `run-failure.test.ts` 用例 C 扩展断言 |
| AC3 / AC4 / AC5 | `src/e2e/` 既有用例扩展断言（`run-task.test.ts:170` 的 `S-HUMAN_REVIEW` 也在内） |
| AC7 | `src/cli/run-task.test.ts` 注入替身断言退出码与话术 |
| AC9 | 负对照：把 R3 判据改成一律 `ok`，AC1 / AC6 必须红 |

负对照必须做完就还原，结果记进 `implement.md`。
