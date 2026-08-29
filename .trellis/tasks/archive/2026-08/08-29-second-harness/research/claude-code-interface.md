# Claude Code CLI 接口（本机实测 + 文档交叉）

> 任务：`.trellis/tasks/08-29-second-harness`
> 日期：2026-08-29
> 二进制：`/Users/jionpz/.nvm/versions/node/v24.14.1/bin/claude`，`2.1.222 (Claude Code)`
> 纪律：argv / 开关以本机 `--help` 为准；事件流字段若本会话未抓到样本，标 `未验证`，不编造。

对照归档：`.trellis/tasks/archive/2026-08/08-22-keel-architecture-framework/research/harness-interfaces.md`（官方文档，非本机 stdout）。

---

## 0. 本机会话核验了什么

| 项 | 结果 | 方式 |
|---|---|---|
| 版本 | `2.1.222` | `claude --version` |
| 登录 | `loggedIn: true`，`authMethod: oauth_token` | `claude auth status` |
| `ANTHROPIC_API_KEY` | 沙箱环境**未见**该变量 | `env`（sandbox） |
| `-p` 真跑一轮拿到 JSON/stream 样本 | **未验证**（本会话未落盘 stdout） | — |
| `--resume` 真正恢复上下文 | **未验证** | — |
| 退出码 0 / 非 0 | **未验证**（help 未写表） | 文档称失败也可能打在 stdout result |

---

## 1. 非交互入口 ✅（help 实测）

```
-p, --print    Print response and exit
```

help 原文要点：

- 非 TTY / `-p` **跳过 workspace trust 对话框**
- 校验失败的 settings **静默忽略**（无错误对话框）
- 「Only use this in directories you trust」

Adapter **必须**再加 `--bare`（见 §5），不能只靠 `-p`。

工作目录：help **没有** `--cwd`。落点 = spawn 的 `cwd`（`spec.workspace.path`）。
`--add-dir` 可追加；v0.1 不需要则不加。

无 `--max-time`。墙钟仍走 Keel `pipeline` watchdog（与 OMP 的 `--max-time` 不对称，本任务不改 R-009）。
有 `--max-budget-usd`（仅 `--print`）：可映射 `limits.budget_usd`；未设则省略。

---

## 2. 输出格式 ✅（help 实测）

`--output-format`（仅 `--print`）：`text` | `json` | `stream-json`。

MVP 建议：`--output-format stream-json`，以声明 `CAP-STREAM` 并与文档中 `type=result` 末行对齐。
若 parser 先用 `json` 单对象更稳，也可以，但 **不要同时宣称 CAP-STREAM 却只消费非流式 json**。

`--verbose`：help 只写「Override verbose mode setting」，**未写** stream-json 是否必须。
旧文档要求 `--verbose --include-partial-messages`。本机是否必须：**未验证**。
MVP 先不要 `--include-partial-messages`（增量 chunk 对 post_validate 无用）。

`--json-schema`：help 确认存在。本任务 **不启用**（D2 `post_validate`）。因此 **不要声明 `CAP-STRUCTURED_OUTPUT`**，直到 native 路径接线；`startRun` 对 `mode=native` 拒绝。

---

## 3. Resume ✅ 开关存在 / 行为未验证

```
-r, --resume [value]     Resume by session ID
--session-id <uuid>      Use a specific session ID (must be valid UUID)
--no-session-persistence 仅 --print；禁用落盘，不可 resume
```

文档（归档）：`json` 结果的 `.session_id` 可喂给 `--resume`。
本机是否仍是该字段：**未验证**。Parser 必须从实测或文档字段读取，缺则 `session_ref=null`（诚实），不得编造 UUID。

`--no-session-persistence`：**不要加**（否则 CAP-RESUME 名存实亡）。

---

## 4. 成本 ✅ 开关/文档 / 字段未验证

help：`--max-budget-usd`。归档文档：`json` 含 `total_cost_usd`，且为 **client-side estimate**。
→ `cost_basis: 'estimated'`。字段名以将来 fixture 为准；没有就 `cost_usd: null` + `unavailable`，**不要猜数字**。

---

## 5. `--bare` = `CAP-UNTRUSTED_WORKSPACE`（help 原文，必须）

help 对 `--bare`：

- 跳过 hooks / LSP / plugin sync / attribution / auto-memory / keychain / **CLAUDE.md 自动发现**
- `CLAUDE_CODE_SIMPLE=1`
- **Anthropic auth 只认 `ANTHROPIC_API_KEY` 或 `--settings` 的 `apiKeyHelper`；OAuth 与钥匙串一律不读**

Keel 指向任意 worktree：`workspace.untrusted=true` 时 Adapter **必须**加 `--bare`。
不加 = 目标仓 `.claude/settings.json` / `.mcp.json` 可在无提示下执行（归档 1.6）。

**凭据后果（产品约束，不是优化）：**

- 本机当前是 **OAuth 登录**，`--bare` 会把它丢掉
- 缺 `ANTHROPIC_API_KEY` 时，untrusted 路径应在 **preflight 第 0 秒失败**，文案写明 `--bare` 不读 OAuth
- 不得为了「本机 OAuth 能跑」而省略 `--bare`（那是假绿 + 安全回退）

`apiKeyHelper` 经 `--settings` 接 OAuth：**未验证**，本任务不做。

`--safe-mode` 仍加载 auth/permissions，**不能**代替 `--bare`。

---

## 6. 权限 ✅（help 实测）

```
--permission-mode    acceptEdits | auto | bypassPermissions | manual | dontAsk | plan
--tools              "" 禁用全部 | default | 名列表（Bash,Edit,Read）
--allowedTools
```

归档文档：`-p` 默认 permission 是 Manual，**必须显式传模式**。

Keel `permissions.mode` 映射（按文档语义，非本机跑过）：

| Keel | Claude |
|---|---|
| `manual` | `manual` |
| `accept_edits` | `acceptEdits` |
| `auto` | `dontAsk`（文档：适合锁定 CI；比 `bypassPermissions` 更窄） |
| `deny_unlisted` | `manual` + `--allowedTools` 白名单 |

`auto` → `dontAsk` 若实测过宽/过窄，记入 prd，不静默改成 `bypassPermissions`。

`allowed_tools.length === 0` → `--tools` `""`（help：Use `""` to disable all tools）。

---

## 7. 建议 argv（untrusted + post_validate）

```
claude -p --output-format stream-json --bare --permission-mode <mapped> --tools <...>
```

- spawn `cwd` = `spec.workspace.path`
- prompt 放 argv 末位（与 OMP 相同：必须读完整个 stdout，stdin ignore）
- 有 `spec.resume` / 上一轮 `session_ref` 时加 `--resume <id>`
- 仅当用户显式 `--model` / `KEEL_MODEL` 时加 `--model`；**禁止**把 OMP 缺省 `deepseek-v4-flash` 传给 claude
- `limits.budget_usd` 有值 → `--max-budget-usd`
- **不要**加 `--no-session-persistence`、`--json-schema`、`--dangerously-skip-permissions`

---

## 8. Capability 声明（本任务）

| ID | 声明？ | 依据 |
|---|---|---|
| CAP-HEADLESS | ✅ | `-p` help |
| CAP-UNTRUSTED_WORKSPACE | ✅ | `--bare` help |
| CAP-STREAM | ✅ | `--output-format stream-json` help；事件字段 **未验证** |
| CAP-RESUME | ✅ | `--resume` help；恢复上下文 **未验证** |
| CAP-COST | ✅ | 文档 `total_cost_usd`；本机字段 **未验证** → estimated |
| CAP-PERMISSION | ✅ | `--permission-mode` / `--tools` help |
| CAP-STRUCTURED_OUTPUT | ❌ 本任务 | 有 `--json-schema` 但未接线；native 拒绝 |
| CAP-MODEL_OVERRIDE | 可选 | help 有 `--model`；缺省不传 |
| CAP-INTERRUPT | ❌ | 与 OMP 一样靠进程组 SIGTERM；不宣称 SDK interrupt |
| CAP-PROBE | ❌ | `system/init.capabilities[]` 本机 **未验证** |

`tierOf` → 若 HEADLESS+RESUME+STREAM+COST 均声明则为 **L2**。

---

## 9. 解析器约束

- 纯函数，fixture 单测，不起进程（对标 `omp-parse.ts`）
- 必须消费完整 stdout（OMP SIGPIPE 课）
- `stream-json`：按行 JSON；文本/费用/session 以文档所述末行 `type=result` 为准，**字段缺失则 null**
- 非 JSON 行进诊断数组，不要当协议成功
- 无 `result` / 无文本 → `PROTOCOL_ERROR`，不要空字符串冒充成功（post_validate 需要非空 text）

本机 fixture：本会话未抓到。可用文档形状造 **最小合法样本** 测 parser；真实集成放到 `KEEL_REQUIRE_CLAUDE=1` 或 acceptance，**禁止 mock claude 二进制行为**。

---

## 10. Preflight

对标 `preflightOmp`：

1. `claude --version` 失败 → 抛错，不 skip，不走到 T-031
2. 即将跑 untrusted（Keel worktree 皆是）且无 `ANTHROPIC_API_KEY` → 抛错，说明 `--bare` 不读 OAuth
