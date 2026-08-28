# 错误处理

> 记录**实际**做法。来源：`08-22-repo-skeleton` 任务，`src/contracts/errors.ts`。

---

## 用 `Result<T>` 表达可预期的失败，不用异常

```ts
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: KeelError }
```

契约方法一律返回 `Result<T>`。

理由：可预期的失败（凭据失效、超时、schema 不合格）是**业务流程的一部分** ——
它们要进 `run.error_kind`、要作为状态机 guard 的输入。
用异常表达会让这些信息在调用栈里丢失类型。

异常只留给**编程错误**：不变量被破坏、不可能到达的分支。

---

## `ErrorKind` 是封闭注册表

12 个 kind，定义在 `src/contracts/errors.ts`，与
`docs/05-contracts/README.md` 的表格一致。**新增 kind 要同时改两处。**

## `retryable` 不是建议

它是 `docs/04-state-machine.md` 中 `T-030`（重试自环）与 `T-031`（升人工）的
**guard 输入**。标错的后果是实打实的：

- 把不可重试的标成可重试 → 系统白白重跑到 `max_attempts` 才升人工
- 反过来 → 一次偶发失败直接惊动人

判断依据是**「再试一次有没有可能不同」**：

| 不可重试 | 可重试 |
|---|---|
| `AUTH_FAILED` 凭据失效 | `HARNESS_UNAVAILABLE` 进程启动失败 |
| `PERMISSION_DENIED` 越权 | `PROTOCOL_ERROR` 输出解析失败 |
| `BUDGET_EXCEEDED` 预算耗尽 | `RUN_TIMEOUT` 超时 |
| `CAPABILITY_UNSUPPORTED` 能力不支持 | `WORKSPACE_ERROR` 工作区冲突 |
| `RUN_CANCELLED` 人工取消 | `SCHEMA_VIOLATION` 提案格式不合格 |
| `CONTEXT_BUDGET_EXCEEDED` 上下文放不下 | `CONFLICT` 并发写入冲突 |

`CAPABILITY_UNSUPPORTED` 值得单说：它表示**调了 Adapter 未声明的能力**，
这是编程错误而非运行时故障 —— 重试永远是同样结果。

---

## 校验失败 ≠ 执行失败

Proposal 不符合 schema 时走 `R-007`：把 `violations` **回灌给 Session 让它改**，
而不是直接判 Run 失败。只有连续 `max_proposal_retries` 次仍不合格才走 `R-006`。

理由：结构化产物写错格式很常见，让它改一次比重跑整个阶段便宜一个数量级。

---

## 提示词不是保障：反馈显式约束要机械核对（2026-08-27，AC5）

现象：`rfc_draft` 对「风险自报」连续两次给出 `risk/complexity=high`，命中 Policy P1
停在 `S-HUMAN_REVIEW`；Issue 正文已显式写 `risk=low / complexity=low / estimated_files=1`。
把「原样采用反馈约束」写进提示词后模型仍不听 —— **提示词只是请求，不是约束**。

解法：`src/control/proposal/feedback-constraints.ts` —— 从反馈原文用正则解析**显式声明**的
`risk= / complexity= / estimated_files= / security_related=` 键值，与 RFC 的
`policy_facts` 机械核对，冲突即拒收并走 `R-007` 回灌（`validate.ts` 第 4b 步）。

语义边界（容易误解）：
- 这是**范围上限核对**，不是风险豁免。反馈声明的范围是本次改动被允许的上限，
  RFC 自报超出上限说明它写的不是这条反馈要的东西；RFC 仍要过 Policy P1–P4。
- 三次回灌耗尽后 Run 失败走 `T-030/T-031` 升人工 —— 该人看的还是人看。

信任边界（prompt injection 入口）：
- `feedback.body` 是不可信输入。让它约束 `policy_facts` 的前提是 label 闸门
  （只有有 triage 权限的人能给 Issue 打 `keel` label，反馈才会进入系统）。
- 只认「键 = 值」的显式声明；自由文本里的「风险不大」一律不解析。
- 未声明字段缺省 —— 缺省即「由模型自评估」，核对不替模型做裁决。

推广判断：凡「先让模型自觉、再人工兜底」的约束，若失败代价是整条 Run 停摆，
值得把关键几项做成机械核对 + 可回灌的拒绝。

---

## 检查脚本的失败输出

`scripts/` 下的检查脚本失败时必须给出**可操作**的信息，不只是 exit 1：

- 违规的具体位置（文件 : 行号）
- **为什么**这是违规（引用到对应的文档章节）
- 怎么修

参见 `scripts/check-purity.ts` 与 `scripts/check-transition-table.ts`。

## 防假绿

检查脚本必须区分「没有违规」与「没检查到东西」：

```ts
if (files.length === 0) {
  console.error('✗ 扫描到 0 个文件 —— 拒绝以「无违规」通过')
  process.exit(1)
}
```

`check-transition-table.ts` 同理：从 markdown 解析到 0 行即报错。
否则一次文档排版改动会让检查静默失效，而 CI 依然是绿的。

> 这不是假想的风险。本项目的 `check:generated` 就曾因为
> 比较基准写错（用了工作区 vs 索引而非 vs `HEAD`）而**一直是绿的却拦不住手改**，
> 是 Stage 8 的反例验证抓出来的。
> **未经反例验证的检查，等同于没有检查。**

### CLI 真实模式：凭据闸门必须先于副作用

`keel run-task --ci real` / `keel run-issue --ci real`：缺 `KEEL_GITHUB_TOKEN` 时
立刻返回 `AUTH_FAILED`，**不得**先 ingest / 克隆 / 跑模型。否则会留下
「已建 task 却永远建不了 PR」的半成品，且浪费 token。

`run-issue` 组合命令若 ingest 成功、驱动失败：错误 detail 必须带上已 ingest 的
`taskId`（可继续 `keel status`），不能只丢 `run` 侧错误。

缺省 `--ci` 仍是 `passed`（模拟）—— 默认路径禁止悄悄打真实 GitHub API。

### 第二层：skip 之后仍要防假绿（2026-08-24，issue #21）

「扫描到 0 个文件即失败」只防住了目录为空。如果扫描器**搜集了全部文件、
再在循环里 skip 掉测试文件**，那么目录里全是 `.test.ts` 时——
第一层通过（目录有文件），实际扫了个寂寞（生产文件全被 skip）。

解法：过滤后**再检查一次**生产文件集合非空，且对**过滤后的集合**做扫描：

```ts
const prodFiles = files.filter((f) => !f.endsWith('.test.ts'))
if (prodFiles.length === 0) {
  console.error('✗ 只有测试文件、没有生产 .ts —— 全部被 skip,拒绝以「无违规」通过')
  process.exit(1)
}
for (const file of prodFiles) { … }
```

这条是 `check-purity.ts` 实况：`GUARDED_DIRS` 全是 Control Plane 代码，
若某天目录只剩测试文件，原检查会假绿。

### 第三层：「读不到」不等于「通过」（2026-08-28，issue-e2e 第六次验收）

读外部事实源时，最危险的形态是**两种语义共用一个可观测形态**。
此时归并函数若挑一个「宽容」的默认值，就会在另一种语义下造出假绿。

实录：`GitHubProvider.combinedStatus` 把「建 PR 后 CI 还没注册」判成了 `passed`。
Actions-only 仓库的 `commits/{sha}/status` 恒为 `state=pending` + 空 `statuses`，
而 check-run 要过 3–10s 才出现在 `commits/{sha}/check-runs`。于是建 PR 后的头几秒，
两个端点都读不到东西 —— 与「该仓库压根没配 CI」**数据上完全同形**。
旧实现为了「没配 CI 的仓库不该永远卡死」把这一形态归成 passed，
结果 PR 建好 3.4s 就流出 `T-024`，CI 还没 `started_at`，系统已宣布它通过。

纪律：

1. **归并函数不下结论**。三态不够就加一态：把「无人上报」（`unreported`）
   与「有人上报且全绿」（`passed`）分成两个值，如实反映读到了什么。
   「等多久才算真的没人上报」是策略，归调用方（`waitForCi` 的静默期），
   不许塞进读取层当默认值。
2. **给外部系统的注册延迟留静默期**。默认值要宽裕（`emptySettleMs` 取 90s）：
   多等一会儿不伤正确性，早下结论会造出假绿。
3. **终态断言要有外部作证**。`issue-e2e` 的 AC5-3b 会回到 GitHub 核对 head SHA 上
   真有跑完且成功的 check —— 只看 Keel 自己写的事件，等于让被测系统自证。

```ts
// ✗ 读不到就算过 —— 无法区分「没配 CI」与「CI 还没注册」
if (sj.state === 'pending' && sj.statuses.length === 0) return ok('passed')

// ✓ 如实分辨，结论交给带静默期的调用方
if (sj.statuses.length > 0) return ok('pending')
return ok(checkRuns.length > 0 ? 'passed' : 'unreported')
```

与本项目 `T-031` 那条教训同源（重试耗尽升人工与 Policy 人工闸门**同终态**，
只看终态会把基础设施故障判成 AC6，见 `src/acceptance/issue-e2e.acceptance.test.ts`）：
**同形态歧义只能靠加一维事实来分开，不能靠猜一个默认值。**
