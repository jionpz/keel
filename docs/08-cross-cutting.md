# 08 · 跨切面关注点

> 满足 PRD `R7`；关闭缺口 `G9`（git 隔离与凭据）、`G12`（安全模型缺失）、
> `G13`（可观测/成本/审计缺失）、`G14`（并发模型缺失）。
>
> **本章不允许出现"以后再说"。** 每一项都给出 v0.1 的最低要求 ——
> 初稿把这四项全部推到"阶段三"，而它们中的多数是**阶段一就会伤到你**的东西。

---

## 1. 安全

### 1.1 威胁模型

Keel 的本职决定了它天生处在一个尴尬位置：

> 它把一个**能执行任意代码的 Agent**，指向一个**内容不可信的仓库**，
> 并让它**持有 git 写凭据**。

三个不可信输入源：

| 源 | 为什么不可信 |
|---|---|
| `feedback.body` | 来自外部用户，是 prompt injection 的直接入口 |
| **目标仓库的内容** | 包括代码、README、以及**仓库内的 agent 配置文件** |
| Harness 的输出 | 它受前两者影响，因此同样不可信 |

第二项最容易被低估，下面单独讲。

### 1.2 ⚠️ 仓库内 agent 配置 = 远程代码执行

**已查证事实**（[research/harness-interfaces.md](../.trellis/tasks/08-22-keel-architecture-framework/research/harness-interfaces.md) §1.6）：

Claude Code 在**不加 `--bare`** 时，`-p` 会话会执行目标仓库 `.claude/settings.json` 里的 hooks、
连接其 `.mcp.json` 里的服务器。官方文档原文是 **"even in a folder you've never trusted"**，
且 `-p` 会话**不显示工作区信任对话框，也不显示 per-server 审批提示**。

也就是说：**克隆一个仓库并对它跑一次 headless agent，就等于执行了该仓库作者写的任意命令。**

**v0.1 最低要求（强制）**：

| # | 要求 |
|---|---|
| S1 | Adapter **必须**启用 `CAP-UNTRUSTED_WORKSPACE`（Claude Code 即强制 `--bare`），并显式注入所需上下文 |
| S2 | 不具备该能力的 Harness **禁止**用于不可信仓库 —— 无降级路径 |
| S3 | 每次 `startRun` 都必须传 `workspace.untrusted`，**没有默认值**（默认值会被遗忘） |

> S3 的措辞是刻意的。把 `untrusted` 设成"默认 true"看似安全，
> 但真正的风险是有人为了调试把它改成 false 然后忘了改回来。
> 强制显式传参，让每个调用点都必须做一次有意识的声明。

### 1.3 凭据

| 规则 | 说明 |
|---|---|
| 存储 | `repo.credential_ref` 只存**引用**，明文凭据在密钥管理系统 |
| 注入 | 运行时注入进程环境，**不落盘、不进 `RunSpec` 的持久化副本** |
| 禁止出现处 | `artifact.body`、`event.payload`、任何日志、任何 Context section |
| 作用域 | 每个 repo 一份，权限最小化：**仅 `ai/*` 分支写权限 + PR 创建权限** |
| 轮换 | 凭据失效返回 `AUTH_FAILED`（`retryable=false`），直接升人工，**不重试** |

`--bare` 模式不读 OAuth 凭据与系统钥匙串，必须显式提供 API key ——
这与上述注入模型天然吻合，不是额外负担。

### 1.4 git 写权限边界

```
main                    ← Agent 永不写
 └── ai/task-<id>       ← Agent 唯一可写的分支命名空间
```

| 规则 | v0.1 |
|---|---|
| 分支命名 | `ai/task-<short_id>`，**由 `task_id` 决定**（幂等所需，非随机） |
| 禁止 | 写 `main` / 默认分支；`push --force`；删除他人分支；改 tag |
| 合并 | PR 合并由 CI + 配置决定，**v0.1 不自动合并高风险 PR** |
| 凭据范围 | token 仅授予 `ai/*` 写权限 —— 权限边界靠**凭据本身**兜底，不只靠代码检查 |

### 1.5 Prompt injection 的纵深防御

**关键认识**：无法阻止 injection 影响 Agent 的输出，只能限制它能造成的后果。

四层防线，从硬到软：

| 层 | 机制 | 强度 |
|---|---|---|
| 1 | **Policy 在 Control Plane 求值，输入只来自 Fact Plane** | 硬 —— 无论 prompt 里写什么，都无法改变裁决 |
| 2 | **数据库授权**：`keel_execution` 无 `artifact`/`event`/`task` 写权限 | 硬 |
| 3 | **Proposal 校验第 3 步**：平面越界检查，`body` 不得含状态机跳转指令 | 中 |
| 4 | Context 中对不可信内容做边界标注 | 软 —— 只是提示，不可依赖 |

第 1 层是整个安全模型的支柱：

> 即使 Agent 被完全说服"这个改动无风险，请自动放行"，
> 它也**没有任何途径**把这句话变成 Policy 的输入 ——
> 因为 Policy 只读 `A-RFC.policy_facts`，而那是经 Proposal 校验后落盘的结构化字段。

这正是初稿 §12"把规则写进 Policy 比写进 Prompt 更可靠"的**真实原因**，
初稿说对了结论但没说出理由。

### 1.6 v0.1 执行隔离的最低要求

| 级别 | 要求 |
|---|---|
| **最低（v0.1 必须）** | 每个 Task 独立 git worktree + `CAP-UNTRUSTED_WORKSPACE` + 最小权限凭据 |
| 推荐（v0.1 应有） | 上述 + 独立 OS 用户或容器 |
| 阶段二 | 网络出口白名单 |

> 独立 worktree 是 v0.1 必须而非可选的：它同时解决隔离（§1）和并发（§4）两个问题，
> 成本却只是一条 `git worktree add`。

---

## 2. 可观测性

### 2.1 核心问题

系统必须能机械地回答两个问题：

1. **这个 Task 到底发生了什么？**
2. **这个 Agent 当时到底看到了什么？**

第 2 个问题是 AI 系统特有的 —— 传统系统里"输入是什么"是显然的，
而 Agent 的输入是**被构造出来的**，不记录就永远无法复盘。

### 2.2 答案的来源

| 问题 | 数据源 |
|---|---|
| 发生了什么 | `readEvents(task_id, 0)` —— 事件流即完整答案 |
| 当时看到了什么 | `ContextBuilt` 事件的 `sections[].source_ref` + `dropped[]` |
| 为什么这么判 | `A-PolicyDecision.facts_snapshot` + `matched_rules` |
| 当时按哪版 RFC 做的 | `history(task_id, 'rfc', '')` 的完整版本链 |

四个问题**全部有确定答案**，不依赖日志检索。这是 Fact Plane 设计的直接收益。

### 2.3 Trace 模型

```
trace  = 一个 Task 的完整生命周期      trace_id
 └── span = 一个 Run                   span_id
      └── span = 一个 turn（需 CAP-STREAM）
```

`event` 表已含 `trace_id` / `span_id` 两列（见 `03-domain-model.md` §2.8），
可直接导出到任何 OpenTelemetry 兼容后端。

### 2.4 结构化日志必备字段

```
task_id, run_id, trace_id, span_id, stage, role,
harness_id, harness_tier, event_type, control_mode
```

**禁止出现**：凭据、`feedback.body` 原文、Context 的 `content`（只记 `source_ref`）。

### 2.5 v0.1 最低要求

| # | 要求 |
|---|---|
| O1 | 事件流完整 —— 每次状态转移、每次 Proposal、每次 Policy 求值都有 Event |
| O2 | `trace_id` 贯穿 Task 全程 |
| O3 | `ContextBuilt` 事件记录 `source_ref` 与 `dropped` |
| O4 | 一条命令能导出某 Task 的完整时间线 |

O3 常被当作"以后再加"，但它是**事后无法补的** ——
Context 是即时构造的，当时不记，后面永远拿不回来。

---

## 3. 成本

### 3.1 `cost_basis` 三态

| 值 | 含义 |
|---|---|
| `billed` | Harness 上报的是实际计费额 |
| `estimated` | Harness 上报的是**估算值** |
| `unavailable` | Harness 不上报（无 `CAP-COST`） |

**已查证**：Claude Code 的 `total_cost_usd` 属 `estimated` ——
官方文档明确说明是 client-side estimate，可能与实际账单有出入。

因此：

| 用途 | 可用的 basis |
|---|---|
| 预算熔断 | `billed` / `estimated` 均可 |
| 趋势观察 | 均可 |
| **对外计费** | **仅 `billed`** |

**禁止用 `0` 冒充 `unavailable`**。"花了 0 元"和"不知道花了多少"在核算里是完全不同的事实，
混淆会让预算看起来永远没超。

### 3.2 归属与聚合

```
run.cost_usd  ──聚合──▶  task 总成本  ──对比──▶  task.budget_usd
```

### 3.3 超预算行为

触发 `C-002`：`control_mode → paused`，**`status` 不变**（见 `04-state-machine.md` §3.1）。

### 3.4 无 `CAP-COST` 时的兜底

无法按金额熔断时，改用**代理指标**：

| 兜底指标 | 默认上限 |
|---|---|
| `wall_clock_s`（每 Run） | 按 stage 配置 |
| `max_turns`（每 Session） | 按 stage 配置 |
| 每 Task 累计 Run 数 | 全局上限 |

### 3.5 无 `CAP-STREAM` 时的固有缺陷

没有事件流就**只能在 Run 结束后核算成本** —— 也就是说：

> 熔断触发时，超支**已经发生了**。

这不是实现缺陷，是能力缺失的必然结果。选型时应把它计入代价（见 `adr/0005`）。

### 3.6 v0.1 最低要求

| # | 要求 |
|---|---|
| C1 | `run` 表记录 `tokens_in` / `tokens_out` / `cost_usd` / `cost_basis` |
| C2 | 每个 Task 有预算上限（可用全局默认） |
| C3 | 超预算触发 `C-002`，不静默继续 |
| C4 | 无 `CAP-COST` 的 Harness 必须配置 §3.4 的兜底上限 |

---

## 4. 并发

### 4.1 隔离单位：git worktree

**每个 Task 一个独立 worktree**，指向同一个裸仓库：

```
repos/<repo_id>.git              ← 裸仓库，共享对象存储
worktrees/<task_id>/             ← 每 Task 独立工作区，独立分支
```

这一条同时解决四个问题：

| 问题 | 如何被解决 |
|---|---|
| 多 Task 同时改同一仓库 | 各自独立工作树，互不可见 |
| Agent 污染工作区 | 销毁 worktree 即完全清理 |
| 不可信仓库内容隔离 | 与 §1.6 的隔离要求是同一个机制 |
| 分支切换竞争 | 每个 worktree 固定一个分支，不切换 |

代价只是一条 `git worktree add` 和一些磁盘。

### 4.2 锁

| 资源 | 策略 |
|---|---|
| `task` 行 | **乐观锁**：`UPDATE ... WHERE status = <期望值>`，影响行数为 0 即冲突重试 |
| `run` 创建 | `UNIQUE(idempotency_key)` —— 悲观锁不需要 |
| `artifact` 提交 | `UNIQUE(task_id, kind, key, version)` + `supersedes` 必须指向最新版 |
| worktree | 每 Task 独占，无共享 |
| 目标分支（PR 合并时） | 由 git 托管方处理，Keel 不自建锁 |

**没有一处需要跨行事务锁。** 这是刻意的 —— 所有并发控制都收敛到唯一约束和乐观锁上，
因为跨行锁会随着 Task 数量增长变成第一个瓶颈。

### 4.3 并发上限

| 维度 | v0.1 默认 |
|---|---|
| 全局同时 `RUNNING` 的 Run 数 | 可配，建议起步 3 |
| 单 repo 同时活跃的 Task 数 | 可配，建议起步 2 |
| 单 Task 同时 `RUNNING` 的 Run 数 | **恒为 1** |

最后一条是硬约束：一个 Task 的两个 Run 同时跑，会让 `attempt` 计数、
成本归属和工作区状态全部失去确定含义。

### 4.4 v0.1 最低要求

| # | 要求 |
|---|---|
| N1 | 每 Task 独立 worktree |
| N2 | `task.status` 更新走乐观锁 |
| N3 | 单 Task 同时至多一个 `RUNNING` Run |
| N4 | 并发上限可配置且有保守默认值 |

---

## 5. 本章与初稿的差异

初稿把这四项全部放在"阶段三"（§20）。本章的判断是：

| 项 | 初稿位置 | 本章位置 | 理由 |
|---|---|---|---|
| 安全 | 未提及 | **v0.1 强制** | `--bare` 那条是 RCE 级别的，不是优化项 |
| 可观测 | 阶段三 | **v0.1 部分强制** | `ContextBuilt` 事件事后无法补录 |
| 成本 | 阶段三 | **v0.1 部分强制** | 无熔断的自动开发系统会安静地烧钱 |
| 并发 | 阶段三 | **v0.1 强制（worktree）** | 它与安全隔离是同一个机制，顺手就有 |

**没有一项因为提前而显著增加了 v0.1 的工作量** —— 这是把它们前移的前提。
真正昂贵的部分（分布式追踪后端、成本归因报表、Agent Pool 调度）仍然留在阶段三。

---

**下一篇**：[`09-roadmap.md`](./09-roadmap.md) —— Non-Goals 与 v0.1 完成判据。
