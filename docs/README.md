# Keel 架构框架文档集

> 本文档集把 [`archive/AI_Engineering_Runtime_Architecture.md`](./archive/AI_Engineering_Runtime_Architecture.md)（22 章初稿）
> 收敛为**决策完备、可落地**的架构框架。
>
> **完成判据**：一个没参与过讨论的开发者拿到本文档集，能直接开始写阶段一代码，
> 不需要再自己发明任何 schema、接口签名或状态转移。

---

## 建议阅读顺序

阅读顺序即依赖顺序。**术语必须最先看** —— 初稿最大的混用正在那里。

| # | 文档 | 内容 | 关闭的初稿缺口 |
|---|---|---|---|
| 1 | [`01-overview.md`](./01-overview.md) | 定位、中心不变量、三平面模型、Non-Goals 摘要 | `G16` `G17` |
| 2 | [`02-glossary.md`](./02-glossary.md) | **术语表 + 废弃词对照** | `G1` |
| 3 | [`03-domain-model.md`](./03-domain-model.md) | 实体、逻辑 schema、**写权限矩阵** | `G11` |
| 4 | [`04-state-machine.md`](./04-state-machine.md) | Task 级 + Run 级转移表、幂等与重放 | `G8` |
| 5 | [`06-artifacts.md`](./06-artifacts.md) | 8 类产物的语义与示例 | `G4` `G6` |
| 6 | [`05-contracts/`](./05-contracts/) | 7 个核心接口契约 | `G3` `G5` `G7` `G10` |
| 7 | [`07-flows.md`](./07-flows.md) | 3 条端到端流程（**骨架的证伪测试**） | — |
| 8 | [`08-cross-cutting.md`](./08-cross-cutting.md) | 安全 / 可观测 / 成本 / 并发 | `G9` `G12` `G13` `G14` |
| 9 | [`09-roadmap.md`](./09-roadmap.md) | Non-Goals、v0.1 判据、阶段触发条件 | `G15` `G16` `G17` |
| — | [`adr/`](./adr/) | 11 份架构决策记录（ADR-0001～0011） | `G2` |
| — | [`schemas/`](./schemas/) | 11 份机器可读 JSON Schema（含 `managed/` 3 份） | — |

**赶时间只读三篇**：`01-overview` → `02-glossary` → `04-state-machine`。

### 下一版生产方案与实施进度

[jstack 主工作流与天问代理决策](./plans/jstack-tianwen/README.md)：完整生产目标及接口、交付票与验收场景。JT-01 只读影子链路、项目记忆、委托代批、路线图/多 ticket、授权与 PR 网关、统一服务已合入 `main`（JT-01～JT-06）；JT-07 的 `doctor` 支持矩阵与试运行账本已实现，真实 7 天试运行、独立评测与生产准入仍未完成。

当前路线的进度与原生依赖见 GitHub [#85](https://github.com/jionpz/keel/issues/85)：JT-01 剩余验收 [#86](https://github.com/jionpz/keel/issues/86)，JT-02～JT-07 为 [#90](https://github.com/jionpz/keel/issues/90)～[#95](https://github.com/jionpz/keel/issues/95)。历史 v0.1/阶段二结论属于 `legacy-v01`，不代表 JT 路线已完成。

---

## 文档约定

### 可寻址 ID

文中所有引用都可回溯到定义处：

| 前缀 | 含义 | 定义处 | 例 |
|---|---|---|---|
| `S-*` | Task 状态 | `04` §1.1 | `S-RFC_READY` |
| `T-NNN` | Task 级转移 | `04` §2 | `T-012` |
| `C-NNN` | `control_mode` 转移 | `04` §3.1 | `C-002` |
| `R-NNN` | Run 级转移 | `04` §4.2 | `R-007` |
| `A-*` | 产物类型 | `06` §1 | `A-RFC` |
| `CAP-*` | Harness 能力 | `05-contracts/harness-adapter.md` §1.1 | `CAP-RESUME` |
| `I*` | 不变量 | `03` §3 | `I5` |
| `G*` | 初稿缺口 | 任务 `prd.md` | `G8` |
| `ADR-NNNN` | 架构决策 | `adr/` | `ADR-0003` |

### 其他约定

| 约定 | 说明 |
|---|---|
| **语言** | 中文写作；技术术语、接口名、字段名保留英文 |
| **`未验证` 标记** | 任何未经查证的外部系统能力断言都必须带此标记。**宁可留白，不可编造** |
| **接口签名** | 一律语言中立伪代码。实现语言已定为 TypeScript（`ADR-0002`），但契约**刻意保持语言中立** —— 读者不只是 Keel 的代码，还有 Harness 实现者与人工操作者 |
| **方法优先级** | 每个接口方法必须标注 `[v0.1 必须]` 或 `[可延后]`，没有第三种 |

---

## 当前状态与已知空白

| 项 | 状态 |
|---|---|
| 文档集 | ✅ 完成 |
| Harness 接口调研 | ⚠️ **完成 Claude Code 与 OMP**（后者见 ADR-0005 修订）；其余属阶段二。Claude Code 已于 2026-10-26 在真机跑通到 `S-DONE`；专门的 `claude-code-e2e` 套件是否完成仍无当前证据，不能据此宣称「Harness 可替换」已完整评测。 |
| `ADR-0002` 实现语言 | ✅ **Accepted — TypeScript / Node** |
| `ADR-0003` Workflow engine | ✅ **Accepted**（2026-08-26 查证:硬约束已自动化强制,迁移路径确证） |
| `ADR-0005` Harness 分级 | ✅ **Accepted — Claude Code + OMP 首批**（2026-08-23 修订;OMP 接入时实测,其余 harness 未查证） |
| 仓库骨架 | ✅ 完成 —— 四条架构约束已机械化，见下 |
| v0.1 实现 | ✅ 历史阶段完成 —— 核心闭环 + 真实 GitHub PR/CI + durable timer + CLI 已落地（`GitHubProvider` 实现 PR 网关与 CI 网关，编排器经 `opts.ci` 消费）；这是 `legacy-v01` 结论，不是 JT 路线完成 |
| JT 路线（jstack + 天问） | ⏳ JT-01～JT-06 已合入 `main`；JT-07 readiness 工具已实现，真实 2–3 项目 7 天试运行与评测未完成。见 [#85](https://github.com/jionpz/keel/issues/85) 与 [#95](https://github.com/jionpz/keel/issues/95) |

### CLI 入口（2026-11-10 现状）

```bash
pnpm run build                 # 产 dist/,bin 指向 dist/cli/index.js
pnpm keel --help               # 完整命令清单以 src/cli/run.ts 的 HELP 为准
```

开发未 build：`pnpm tsx src/cli/index.ts <cmd>`。当前已存在的主要入口：

| 命令 | 用途 |
|---|---|
| `serve` / `service-status` / `service-health` | 统一常驻服务、只读角色/队列快照与无副作用健康检查（JT-06） |
| `managed <investigate\|ticket-*\|policy-*\|workflow-*\|action-*\|memory-*\|...>` | jstack 调查、ticket、授权、路线图、PR 网关与项目记忆（JT-01–05） |
| `doctor [--harness omp\|claude\|pi] [--scope full\|ticket] [--json]` | Harness/平台/数据库/写沙箱/试运行就绪矩阵（JT-07） |
| `trial-start` / `trial-status` / `trial-stop` | 2–3 项目、7 天、30 代决、5 完成任务的试运行账本（JT-07） |
| `backup` / `restore-verify` | 一致性备份与隔离恢复校验（JT-06） |
| `console` | Web 控制台、人工裁决与澄清答复（默认绑定 `127.0.0.1:4321`，需口令登录；`KEEL_CONSOLE_HOST` 可改监听地址） |
| `timer-worker [--interval <ms>]` | 到期 timer 收割；`--interval` 常驻 |
| `run-task` / `run-issue` | 驱动已有 task / GitHub Issue 到终态 |
| `status <taskId>` | task / run / 事件摘要 |
| `decide` / `answer` | 人工裁决 `S-HUMAN_REVIEW`、回答 `S-NEED_CLARIFICATION` |
| `register-repo` / `ingest-issue` | 注册 repo（可绑定本地目录）、把 Issue 收为 task |
| `poller` | 常驻扫描各 repo 的 issue label 并驱动 |
| `unlock` | 清理 SIGKILL 留下的 per-repo 锁 |

### 文档与代码的一致性是被强制的，不是靠自觉

仓库骨架把四条约束变成了 CI 会失败的东西（`pnpm run check`）：

| 约束 | 强制手段 | 保护的是 |
|---|---|---|
| `C1` | 重新生成后与 `HEAD` 比对 | `docs/schemas/` 是产物类型的唯一事实来源 |
| `C2` | dependency-cruiser | Execution Plane 不得写 Fact Plane（不变量 `I5`） |
| `C3` | dependency-cruiser + 禁用全局扫描 + 确定性测试 | 转移函数必须是纯函数（`ADR-0003`） |
| `C4` | 解析本目录 `04-state-machine.md` 的转移表并与代码比对 | **改了文档不改代码（或反之）会红** |

`C4` 意味着：**修改 `04-state-machine.md` §2 的转移表后，
必须同步 `src/control/transition/table.ts`，否则 CI 不过。**

调研原始记录在 `docs/archive/tasks/2026-08/08-22-keel-architecture-framework/research/`。

---

## 关于初稿

初稿保留在 [`archive/`](./archive/)，**不删除**。

它把"要做什么"表达清楚了 —— 七条原则、Session/State 的分野、
分层可替换的主张，都来自它。本文档集做的是把这些主张**变成可执行的机制**，
而不是取代它们。

初稿中被本文档集**修正**的地方（而非仅仅细化的地方）：

| 初稿 | 修正 | 位置 |
|---|---|---|
| `State` 同时指状态机位置与事实集合 | 拆为 `task.status` 与 `A-State` | `02` §6 |
| 单层状态机，`REWORK` 是一个状态 | 拆为 Task 级 + Run 级；`REWORK` 不再需要 | `04` §0、§1.2 |
| `AUTO_DEVELOP` 是一个状态 | 它是 Policy 裁决结果，是 guard 不是状态 | `04` §1.2 |
| `PAUSE`/`HUMAN_TAKEOVER` 在状态链里 | 提为正交的 `control_mode` 维度 | `04` §3 |
| Model 是 Keel 管理的一层 | Model 归 Harness 管；`ModelProvider` 只服务运行时自用 | `05-contracts/harness-adapter.md` §4 |
| Policy 规则集有未定义的冲突 | 严格性偏序 + 默认 deny | `05-contracts/policy-engine.md` §1.3 |
| 安全/可观测/成本/并发全在"阶段三" | 其中多数前移到 v0.1 强制 | `08` §5 |
