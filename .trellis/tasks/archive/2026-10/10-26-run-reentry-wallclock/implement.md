# 执行计划 · firstRun 重复进入 + --wall-clock

> 目标文件都是「小而集中」的：`transition/table.ts`、`driver/effects.ts`、两个 CLI 入口。
> 过程中不要动 `createRun` 的键算法（见 `design.md` §2）。

## 步骤

### 1. 改表：四处 `firstRun` → `nextRun`

`src/control/transition/table.ts`

- `T-010`（S-BRAINSTORM → S-RFC_DRAFT）：`firstRun('rfc_draft')` → `nextRun('rfc_draft')`
- `T-012`（S-RFC_READY → S-DEVELOPING）：`firstRun('develop')` → `nextRun('develop')`
- `T-017`（S-DEVELOPING → S-QA）：`firstRun('qa')` → `nextRun('qa')`
- `T-018`（S-QA → S-REVIEW）：`firstRun('review')` → `nextRun('review')`

每处加一行注释说明「二次进入路径」，让后来者不必重推一遍（样式参考 T-014/T-019）。

保留 `firstRun`：`T-002`（pm）/ `T-003`（brainstorm）/ `T-004`（rfc_draft），
理由写进步骤 2 的白名单。

**验证**：

```bash
pnpm run check:transitions
pnpm vitest run src/control/driver/driver.test.ts
```

### 2. 白名单检查

`src/control/transition/transition.test.ts`：新增用例，导出常量 + 双向断言
（见 `design.md` §5）。断言对象是**转移 id**，不是阶段名 —— 同一阶段
（rfc_draft）既有一处 `first` 也有一处 `next`，按阶段断言会看不出区别。

**验证**：

```bash
pnpm vitest run src/control/transition/transition.test.ts
```

**负对照（必做，做完立刻还原）**：把 `T-017` 临时改回 `firstRun('qa')`，
上面这条检查必须红；还原后再跑一次必须绿。把这次负对照的结果记进本文件末尾。

### 3. 行为测试：二次进入真的会建下一个 run

`src/control/driver/driver.test.ts`，沿用现有的 `toDeveloping(taskId)` 装置：

- **扩** `QA 失败且未达上限 → 走 T-019`：断言 `S-DEVELOPING` 之后继续
  `stageOutcome(develop,'implemented')` + `RunSucceeded(develop)` →
  `run` 里出现 `(stage='qa', attempt=2)`，且该次没有 `CreateRun` 的 `SideEffectSkipped`。
- **新增** T-022 路径：review 判 fail → 返工 → 回到 `S-REVIEW` 时 `(review,2)` 存在。
- **新增** T-016 路径：`S-HUMAN_REVIEW` 收到 `HumanRequestedRework` →
  `S-BRAINSTORM`（`brainstorm,2`）→ 收敛 → `(rfc_draft,2)` → `ArtifactCommitted`
  → `(develop,2)`。这条同时证明人工回炉真的能走完。

**验证**：

```bash
pnpm vitest run src/control/driver/driver.test.ts
```

### 4. `SideEffectSkipped` 带 `existing_status`

`src/control/driver/effects.ts` 的 `createRun` 冲突分支（见 `design.md` §4）：

1. `SELECT status FROM run WHERE idempotency_key = $1`
2. 事件 payload 加 `existing_status`
3. **不改变**返回值（仍 `outcome:'skipped'`）、**不改变**事务语义

`src/control/driver/effects.test.ts` 补两条：

- 同键 run 已 `SUCCEEDED` 再派发 → `SideEffectSkipped.existing_status === 'SUCCEEDED'`
- 同键 run 仍 `PENDING` → `existing_status === 'PENDING'`（既有 `driver.test.ts:393`
  那条保持绿，作为真重放的证据）

**验证**：

```bash
pnpm vitest run src/control/driver/effects.test.ts src/control/driver/driver.test.ts
```

### 5. `parseWallClock` + 两个 CLI 入口

1. `src/cli/run-task.ts`：新增并导出 `parseWallClock(raw: unknown): Result<number | undefined>`
   - `undefined` → `ok(undefined)`（走下游默认 180）
   - `number` 且正整数 → `ok(n)`
   - 其余（字符串数字也算非法，**不**做 `Number()` 兜底）→
     `err(makeError('CAPABILITY_UNSUPPORTED', ...))`，detail 写明期望与「不会静默回退」
2. `runTaskMain`：解析 `flags['wall-clock']` → 校验失败 `console.error` + `exitCode = 1`；
   成功则并入 `runTask(...)` 的 options（与 `wallClockS` 同名）
3. `src/cli/run-issue.ts` 的 `runIssueMain`：同上
4. 帮助文本三处：`src/cli/index.ts` 的 `HELP`（第 8、12、31、35 行附近）+
   `runTaskMain` 的用法串 + `runIssueMain` 的用法串

> `parseArgs` 会把 `600` 解析成 `number`、`abc` 解析成 `string`、`--wall-clock` 单独出现
> 解析成 `true` —— 三种都要落到 `err`。

**验证**：

```bash
pnpm vitest run src/cli/run-task.test.ts src/cli/run-issue.test.ts src/cli/cli.test.ts
```

### 6. CLI 测试

- `600` / `"600"` 之外的合法形态 → 透传到 `runTask` 的 `wallClockS`（用现有注入桩断言，
  不起真进程）
- `0` / `-5` / `abc` / `1.5` → 拒绝，报错文本含「正整数」，退出码 1
- 省略 → `wallClockS` 为 `undefined`（下游默认 180，**不是** 0）

### 7. 文档同步

- `docs/04-state-machine.md`：`T-010` / `T-012` / `T-017` / `T-018` 的产物列
  不再是 `run(x, 1)`；`T-017`/`T-018` 改为「创建 `run(qa, n)`」这类
  与 attempt 算法一致的写法。§5.1 幂等键一节若提到「首轮恒为 1」一并修。
- `docs/07-flows.md`：§3 流程三第 2 步确认措辞与实现一致（返工后能进 `run(qa,2)`）。
- `docs/CLI` 若有用法清单，补 `--wall-clock`。

**验证**：

```bash
pnpm run check:transitions
```

### 8. 全量门槛

```bash
pnpm run check
```

---

## REVIEW GATE 1 —— 步骤 1 + 2 之后

停下来核对：白名单是**双向**断言（多/少都红）、四处改动各自带二次进入路径注释、
`check:transitions` 绿。若发现还有第五处 `firstRun` 落在可二次进入的位置，
回 `design.md` §3 补表格再改。

## REVIEW GATE 2 —— 步骤 5 之后

停下来核对：`--wall-clock abc` 真的以退出码 1 拒绝（不是静默 180）；
帮助文本两处命令 + 顶层 HELP 都出现该旗标。

---

## 回滚

| 范围 | 做法 | 残留 |
|---|---|---|
| 全部 | `git revert <commit>` | 无（无 schema / 无迁移） |
| 仅 B 部分 | 撤 CLI 四处改动 | 无（`wallClockS` 管道本来就有） |
| 仅步骤 4 | 撤 payload 字段 | 旧事件读法不变（字段可选） |

## 不做

- 不改 `createRun` 的 attempt 算法（`design.md` §2）
- 不改「无 PENDING run 即收工」的循环语义（`prd.md` Non-Goals）
- 不加 `KEEL_WALL_CLOCK` 环境变量
- 不新增事件类型

## 负对照记录

| 步骤 | 做了什么 | 红在哪里 | 还原后 |
|---|---|---|---|
| 2 | `T-017` 临时改回 `firstRun('qa')` | 3 条：白名单双向断言 / 「返工阶段一律 next」 / T-017 派发 `qa, next` | 绿（24 passed） |
| 4 | `createRun` 冲突分支去掉 `existing_status` | 2 条：`SideEffectSkipped` payload 的两条用例 | 绿（10 passed） |
| 5–6 | `parseWallClock` 守卫 `raw > 0` → `raw >= 0` | 3 条：解析器「非法值一律拒绝」、`runTaskMain` 闸门、`runIssueMain` 闸门 | 绿（26 passed） |
| 6 | 删掉 `runTaskMain` 里 `wallClockS` 的展开 | 1 条：「600 透传进 `runTask` 的 `wallClockS`」 | 绿（18 passed） |

## 实测记录（2026-10-26）

CLI 端到端（`pnpm tsx src/cli/index.ts`，真库、不跑模型）：

| 命令 | 退出码 | 输出要点 |
|---|---|---|
| `run-task <随机 uuid> --wall-clock 0` | 1 | `收到:「0」` |
| `run-task <随机 uuid> --wall-clock abc` | 1 | `收到:「abc」` |
| `run-task <随机 uuid> --wall-clock 600` | 1 | `找不到 task …`（旗标过闸后进了 `runTask`，**不是**参数错） |
| `run-issue <url> --wall-clock 1.5` | 1 | `收到:「1.5」`，且零写入（闸门在 ingest 之前） |
| `keel --help` | 0 | 两条命令的用法行都含 `[--wall-clock <秒>]` |

全量门槛：`pnpm run check` → 35 files / 449 passed, 5 skipped。

### 与计划的一处偏差（步骤 6）

计划写的是「用现有注入桩断言透传」，但 `runTaskMain` 直接引用同模块的 `runTask`，
ESM 下模块内调用不会被 `vi.mock` 拦截 —— 没有现成桩可断。为了真能断言 `wallClockS`
落位（AC6），给两个入口各加了一个**可选依赖注入参数**（`RunTaskMainDeps` /
`RunIssueMainDeps`，缺省用真实现）。CLI 行为不变，多出的面只有「可传替身」。
不加的话 AC6 只能退化成「读代码相信它透传」。
