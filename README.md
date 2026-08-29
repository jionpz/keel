# Keel — AI Engineering Runtime

> 龙骨：船的主心骨。承载状态 / 工作流 / 会话三层架构的基调。

**一句话**：让 AI、人工、多个 Agent、多个模型、多个 Harness 在同一套软件研发流程中长期协作的运行层。

## 定位

- 不是"又一个 Claude Code"——是编排层之上的 Runtime
- **Session inside, State outside**：Agent 会话是临时计算资源，结构化 State / RFC / Checkpoint 才是事实来源
- 人工与 AI 使用同一套工程规范，可随时 PAUSE → HUMAN_TAKEOVER → RESUME

## 📐 架构文档

**[`docs/`](./docs/README.md) 是架构的事实来源。**

赶时间就读这三篇：
[总览](./docs/01-overview.md) → [术语表](./docs/02-glossary.md) → [状态机](./docs/04-state-machine.md)

| | |
|---|---|
| [`docs/README.md`](./docs/README.md) | 索引、阅读顺序、文档约定 |
| [`docs/05-contracts/`](./docs/05-contracts/) | 5 个核心接口契约 |
| [`docs/schemas/`](./docs/schemas/) | 8 份机器可读 JSON Schema |
| [`docs/adr/`](./docs/adr/) | 6 份架构决策记录 |
| [`docs/archive/`](./docs/archive/) | 立项初稿（已归档，**请勿据其实现**） |

## 中心不变量

> 能在进程崩溃后存活的，只有 Artifact。其余一切都是 Session。

由此推出三个平面，每个平面由它**不许做什么**定义：

| 平面 | 职责 | 硬约束 |
|---|---|---|
| Control | 决定下一步做什么 | 绝不直接调用 LLM；必须可确定性重放 |
| Fact | 唯一事实来源 | 只由 Control Plane 写入 |
| Execution | 干活 | 绝不直接写 Fact Plane；只能 emit 提案 |

Fact 与 Execution 之间只有两条单向通道：`Context` 下行、`Proposal` 上行。
这条边界靠**数据库授权**强制，不靠代码自觉。

## 核心原则

1. State 是事实（对话不是）
2. Session 是计算资源（可创建/暂停/恢复/销毁）
3. Workflow 决定流程（Agent 不自作主张）
4. Policy 决定权限（自动 vs 人工审核）
5. Context Builder 决定上下文（不每次从零读项目）
6. Harness 是执行层（能力分级 + 显式降级，L0 也能跑通闭环）
7. 人工与 AI 同一套规范（**人工被建模为一种 Harness**）

每条原则落成机制的位置见 [`docs/01-overview.md`](./docs/01-overview.md) §4。

## v0.1 完成判据

> 一条真实的用户反馈进入系统后，在无人干预的情况下走完 `S-NEW → S-DONE`，
> 产出一个通过 CI 的 PR；且 `readEvents(task_id, 0)` 能完整重建这个 Task 的全过程。

## 技术栈

**TypeScript / Node**（[`ADR-0002`](./docs/adr/0002-implementation-language.md)）。

选它的主要收益是 `docs/schemas/` 的 8 份 JSON Schema 可以**直接生成类型** ——
让"文档里的 schema"与"代码里的类型"机械对齐，而不是靠人维护同步。
这一步必须纳入 CI，否则选 TS 与选任何语言就没区别了。

契约文档**刻意保持语言中立**，不改写成 TS 语法：它的读者不只是 Keel 的代码，
还有 Harness 实现者与人工操作者。

Workflow engine 推荐 v0.1 自研最小状态机（[`ADR-0003`](./docs/adr/0003-workflow-engine.md)，
Accepted —— 2026-08-26 查证：硬约束已自动化强制，迁移路径确证）。

## 开发

```bash
pnpm install
pnpm run check     # CI 跑的就是这一条 —— 与本地完全一致
```

`check` 聚合了 lint / typecheck / 架构边界 / 类型同步 / 转移表比对 / 纯度 / 测试。

### 四条被机械化的架构约束

骨架的价值不在于「能 build」，而在于把架构约束变成 **CI 会失败的东西**：

| 约束 | 说的是 | 违反时 |
|---|---|---|
| `C1` | `docs/schemas/` 是产物类型的唯一事实来源，TS 类型由其生成、不手改 | `check:generated` 红 |
| `C2` | Execution Plane 不得写 Fact Plane | `boundaries` 红 |
| `C3` | 状态转移必须是纯函数（`ADR-0003`） | `boundaries` + `check:purity` 红 |
| `C4` | 代码转移表必须与 `docs/04-state-machine.md` 一致 | `check:transitions` 红 |

每条都经过**反例验证** —— 逐条制造违规确认检查真的会红，
而不是只看 CI 是绿的（一个什么都不检查的 CI 也是绿的）。

> 改 `docs/04-state-machine.md` §2 的转移表后，必须同步
> `src/control/transition/table.ts`，否则 CI 不过。这是刻意的。

要放宽任何一条约束，**走 ADR**，不要在配置里临时注释掉。

## 状态

**架构框架 + 仓库骨架已完成。** v0.1 最小闭环已跑通：真实反馈在本地 worktree 中无人干预走完 `S-NEW → S-DONE`，事件流可完整重建；回归测试全绿。

**v0.1「进入」环节已闭合**（2026-08-28）：真实 GitHub Issue → `keel run-issue --ci real` → S-DONE + 通过 CI 的真实 PR（`issue-e2e` 验收，路径 T-001→T-024，263s，[PR #45](https://github.com/jionpz/keel/pull/45)）。T-024 经远端核对：真实 Actions check 跑完 `success` 之后才流转，不是「读不到就算过」。同轮验收抓出并修掉一个 T-024 假绿（`unreported` 与 `passed` 同数据形态），详见任务 `08-27-github-issue-automation` 的 `prd.md`。

GitHub PR / CI 集成已完成**真实验收**(2026-08-24,`jionpz/keel`):
真实 push → 真实创建 PR(幂等复用)→ 真实 GitHub Actions 跑完 → CI 状态回读 `passed`,
全链路 77.6s。验收抓出并修复三个真 bug(head 过滤器编码、Actions-only 仓库的
pending 归并、runner 无 omp),记录见任务 `prd.md`。

运行真实验收:`KEEL_GITHUB_TOKEN="$(gh auth token)" KEEL_TEST_REMOTE_REPO=<url> pnpm run test:acceptance`
(缺凭据时明确失败,不静默跳过)。未注入 provider 时系统如实记录 `SideEffectIntent`,不假装成功。
