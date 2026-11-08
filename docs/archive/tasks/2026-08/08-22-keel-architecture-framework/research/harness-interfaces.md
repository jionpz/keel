# Research · Harness 编程接口

> 任务：`.trellis/tasks/08-22-keel-architecture-framework`
> 目的：为 `05-contracts/harness-adapter.md` 的 capability 分级与降级规则提供**事实依据**。
> 纪律：每条非显然断言给出处；查不到的一律标 `未验证`，**不用推测补齐**。

---

## 调研状态

| Harness | 状态 | 来源 |
|---|---|---|
| Claude Code | ✅ 已查证 | 官方文档 |
| OpenAI Codex CLI | ⏳ 待查（网关限流） | — |
| Aider | ⏳ 待查（网关限流） | — |
| OpenCode | ⏳ 待查 | — |
| OpenHands | ⏳ 待查 | — |
| Gemini CLI / Qwen Code | ⏳ 待查 | — |
| Oh My Pi (OMP) | ⏳ 待查 | — |
| TRAE Agent | ⏳ 待查 | — |

> ⚠️ 本文件在网关不稳定的情况下**增量写入**。未标 ✅ 的条目**不得**被下游文档当作已知事实引用。

---

## 1. Claude Code ✅

来源：<https://code.claude.com/docs/en/headless>（"Run Claude Code programmatically"）

### 1.1 非交互入口

```bash
claude -p "Find and fix the bug in auth.py" --allowedTools "Read,Edit,Bash"
```

- `-p` / `--print` 进入非交互模式
- 读 stdin，可管道输入（**上限 10MB**，超出报错退出）
- 退出码：成功 `0`，失败非零。**运行中失败（如认证缺失）会作为 result 打到 stdout**，不是 stderr
- 另有 Agent SDK（Python / TypeScript 包），提供结构化输出、工具审批回调、原生 message 对象

**`--bare`**：跳过 hooks / skills / 自定义命令 / subagents / plugins / MCP servers / auto memory / `CLAUDE.md` 的自动发现。
文档明确称其为"**脚本与 SDK 调用的推荐模式**"，并称未来会成为 `-p` 的默认。

### 1.2 Session resume ✅ 支持

| 方式 | 说明 |
|---|---|
| `--continue` | 续接最近一次会话（跳过 background sessions） |
| `--resume <session_id>` | 续接指定会话 |

`session_id` 从 `--output-format json` 的 `.session_id` 字段取得：

```bash
session_id=$(claude -p "Start a review" --output-format json | jq -r '.session_id')
claude -p "Continue that review" --resume "$session_id"
```

**跨目录可恢复**：v2.1.223 起按 ID 在本机任意项目中查找会话；此前仅限当前项目目录及其 git worktree。

**崩溃语义**：SIGTERM 退出码 `143`，进行中的 turn 留为未完成、不记录 result；
`--resume` 时会**继续那个未完成的 turn**。

→ 对 Keel 的意义：Claude Code 的 session 是**跨进程持久**的，满足 `CAP-RESUME`。

### 1.3 结构化输出 ✅ 支持

`--output-format` 三档：

| 值 | 说明 |
|---|---|
| `text` | 默认，纯文本 |
| `json` | 结构化 JSON，含 `result`、`session_id`、metadata |
| `stream-json` | newline-delimited JSON，实时流式 |

**强制 schema**：`--output-format json` + `--json-schema '<JSON Schema>'`
→ 结果落在 **`structured_output`** 字段。
非法 schema 会以 `Error: --json-schema is not a valid JSON Schema` 退出（v2.1.205 起；此前静默忽略）。
`format` 关键字被接受但**仅作注解，不强制**。

→ 对 Keel 的意义：Proposal 机制可**直接复用** `--json-schema`，
让 Harness 侧就保证提案的结构合法性，减少 `R-007`（校验失败回灌）的往返。

**流式事件**（`--output-format stream-json --verbose --include-partial-messages`）：

| 事件 | 关键字段 |
|---|---|
| `system` / `init` | 会话元数据：model、tools、`mcp_servers`、`plugins`、`plugin_errors`、`mcp_server_errors`、`capabilities[]` |
| `system` / `api_retry` | `attempt`、`max_retries`、`retry_delay_ms`、`error_status`、`error`、`uuid`、`session_id` |
| `system` / `plugin_install` | `status`、`name`、`error` |
| `stream_event` | 增量 delta，如 `.event.delta.type == "text_delta"` |
| `result` | **流的最后一行**：最终文本、成本、session 元数据 |

子 agent 消息通过 `parent_tool_use_id` 关联（主会话该字段为 `null`）。

`system/init` 的 `capabilities[]` 数组用于**特性探测**（如 `interrupt_receipt_v1`），
文档明确建议用它代替版本号比较。

→ 对 Keel 的意义：这正是 `CAP-*` 探测的现成先例 —— Adapter 可在 `system/init` 后**动态校正**静态声明的能力。

### 1.4 成本上报 ✅ 支持（但是估算）

`--output-format json` 的响应含 `total_cost_usd` 及**按模型的成本明细**。

> ⚠️ 文档明确说明这两个数字都是 **client-side estimates，可能与实际账单有出入**
> （<https://code.claude.com/docs/en/agent-sdk/cost-tracking>）。

→ 对 Keel 的意义：`run.cost_usd` 必须标注为**估算**。
预算熔断（`C-002 BudgetExceeded`）基于估算值触发是可接受的，
但**不可用于对外计费**。这一点要写进 `08-cross-cutting.md` 成本模型。

### 1.5 权限与沙箱控制 ✅ 支持

| 机制 | 说明 |
|---|---|
| `--allowedTools "Bash,Read,Edit"` | 白名单，支持 permission rule 语法 |
| permission rule 前缀匹配 | `Bash(git diff *)` —— **`*` 前的空格有语义**，`Bash(git diff*)` 会误匹配 `git diff-index` |
| `--permission-mode auto` | 分类器代替人工审查多数操作 |
| `--permission-mode dontAsk` | 拒绝 allow 规则与只读命令集之外的一切。文档称**适合锁定的 CI 运行** |
| `--permission-mode acceptEdits` | 免提示写文件 + 自动批准 `mkdir`/`touch`/`mv`/`cp` 等 |

`-p` 模式的内置起始权限模式在**所有套餐上都是 Manual**，因此**必须显式传入**想要的模式。

### 1.6 ⚠️ 重大安全发现

> 文档原文（§Start faster with bare mode）：
> 不加 `--bare` 时，`-p` 会话会运行项目 `.claude/settings.json` 里的 hooks、
> 连接其 `.mcp.json` 里的服务器，**"even in a folder you've never trusted"**。
> `-p` 会话**不显示工作区信任对话框，也不显示 per-server 审批提示**。

**这对 Keel 是一级安全约束**：Keel 会把 Harness 指向**任意目标仓库**。
若不加 `--bare`，目标仓库中一个恶意的 `.claude/settings.json` 或 `.mcp.json`
就能在 Keel 的执行环境中获得任意代码执行 —— 且全程无提示。

→ **Adapter 必须强制 `--bare`**，并显式传入所需上下文（`--settings` / `--mcp-config` / `--append-system-prompt`）。
这不是优化项，是必须项。写进 `08-cross-cutting.md` 安全模型。

附带影响：`--bare` 模式下不读 OAuth 凭据与系统钥匙串，必须提供 `ANTHROPIC_API_KEY`
或在 `--settings` JSON 中提供 `apiKeyHelper` —— 这正好与 `repo.credential_ref` 的凭据注入模型吻合。

### 1.7 工作区与结果获取

- 工作目录即当前目录；`--add-dir` 可追加目录
- 文档**未描述**内置的 diff/patch 导出机制 → Keel 侧需自行用 git 读取工作树变更 `未验证：是否存在其他导出方式`
- 后台 Bash 任务在最终结果返回、stdin 关闭后约 5 秒被终止；后台 subagent/workflow 不受此限，
  但从 v2.1.182 起默认最多等 10 分钟（`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` 可调）

### 1.8 能力小结

| Capability | 支持 | 备注 |
|---|---|---|
| `CAP-HEADLESS` | ✅ | `-p` |
| `CAP-RESUME` | ✅ | `--resume <session_id>`，跨进程持久 |
| `CAP-STREAM` | ✅ | `stream-json`，事件类型丰富 |
| `CAP-STRUCTURED_OUTPUT` | ✅ | `--json-schema` → `structured_output` |
| `CAP-COST` | ✅ | `total_cost_usd`，**估算值** |
| `CAP-PERMISSION` | ✅ | `--allowedTools` + `--permission-mode` |
| `CAP-INTERRUPT` | ✅ | SIGINT / SDK `interrupt()`；SIGTERM 留未完成 turn |
| `CAP-CAPABILITY_PROBE` | ✅ | `system/init` 的 `capabilities[]` |

**判级：`L2`**（当前调研范围内的能力上界）。

---

## 2. OpenAI Codex CLI ⏳

`待查证` —— 网关限流中断。

---

## 3. Aider ⏳

`待查证` —— 网关限流中断。

---

## 4. OpenCode ⏳

`待查证`

---

## 5. OpenHands ⏳

`待查证`

---

## 6. Gemini CLI / Qwen Code ⏳

`待查证`

---

## 7. Oh My Pi (OMP) / TRAE Agent ⏳

`待查证`。

> 提醒：这两项在初稿 §2.3 / §19 被列为主要执行层候选，但公开资料可能很少。
> 若最终查不到权威来源，**必须标 `未验证` 并移出 v0.1 首批支持范围**，
> 不得凭名称推测其接口 —— 见 PRD Constraint 2。

---

## 对 Harness Adapter 契约的影响

> 本节随调研推进持续更新。当前仅基于 Claude Code 一家，**结论是初步的**。

### 已可确立的

1. **能力探测应是两段式**：Adapter 静态声明 + 运行时校正。
   Claude Code 的 `system/init.capabilities[]` 证明这不是过度设计，而是上游已有的做法。

2. **成本必须标注为估算**。至少 Claude Code 明确如此。
   `run.cost_usd` 的语义应为"用于预算控制的估算"，不可用于对外计费。

3. **强制隔离宿主配置是安全必须项，不是可选项**。
   `--bare` 这个发现说明：Harness 默认会读取**目标仓库内**的配置并执行。
   Adapter 契约必须包含一个**强制的"不信任工作区"启动模式**，
   任何达不到该要求的 Harness 都不能用于处理不可信仓库。

4. **结构化输出可下推到 Harness**。
   `--json-schema` 说明 Proposal 的 schema 校验有机会在 Harness 侧就完成，
   `R-007` 的回灌重试只作为不支持该能力时的退路。

### 仍需其余 Harness 数据才能确立的

- L0/L1/L2 的**分界线**具体划在哪（取决于最弱的那家能做什么）
- 无 `CAP-RESUME` 的 Harness 究竟有多少 → 决定"从 Artifact 重新物化上下文"这条降级路径的重要程度
- 是否有 Harness 完全不提供结构化输出 → 决定 Proposal 是否需要一条"从自由文本解析"的兜底路径
