# Harness Adapter（Execution → 真实 CLI）

> 记录**实际**做法与踩过的坑。来源：`10-25-claude-auth-config` 任务的真机跑通
> （2026-10-25，本机 claude 2.1.300 + magpie 网关）。
> 2026-11-10 用 claude 2.1.314 复核了工具清单与授权参数
> （证据：`.keel/coordination/2026-11-10/full-delivery/claude-tools-{probe,functional}.jsonl`，
> 只取 `system.init.tools` 与 tool_result 成功字段）。
> 代码在 `src/execution/adapters/{claude-code,omp,human}.ts`。

---

## Scope / Trigger

Adapter 是 Keel 唯一**真正起子进程**的地方。三条契约在这里最容易破：

| 契约 | 破了会怎样 |
|---|---|
| 子进程必须看到**用户配置**，不能看到**父会话运行时** | 同一条本机能跑的配置，经 Keel 跑就失败（实测：`unrecognized_model`，退出码 1） |
| 同一 Run 的多轮必须互不串状态 | 第 2 轮 `awaitResult` 拿第 1 轮结果，墙钟 watchdog 打空，Run 无上限地跑 |
| argv 必须对得上**当前版本**的 CLI | 静默降级（把不存在的工具名塞进 `--tools`，CLI 不报错但列表为空）或直接报错 |

---

## 契约 1：子进程环境隔离

```ts
// src/execution/adapters/claude-code.ts
const p = spawnFn(bin, [...args], {
  cwd,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
  env: sanitizeClaudeEnv(process.env),   // 剔除宿主运行时变量
})
```

**剔除的是「宿主托管信号」，不是凭据**：

- `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` / `CLAUDE_CODE_MODEL_CATALOG` —— 子 claude
  会以为 provider 由宿主托管，于是拒绝 `~/.claude/settings.json` 里的模型
- `CLAUDE_CODE_MESSAGING_SOCKET` / `_TOKEN` —— 子进程可反向连回父会话 IPC
- `CLAUDECODE`、`CLAUDE_CODE_SESSION_ID` / `_HOST_SESSION_ID` / `_ENTRYPOINT` /
  `_EXECPATH` / `_CHILD_SESSION` / `_HOST_AUTH_ENV_VAR` / `_SDK_HAS_HOST_AUTH_REFRESH`

**保留**：`ANTHROPIC_*`（凭据与网关地址）、`CLAUDE_CONFIG_DIR`、`PATH`、代理与证书类。
用**显式黑名单**而不是白名单：白名单会顺手删掉用户合法的运行前提。

实测对照（同一条命令、同一个 argv）：

| 环境 | 结果 |
|---|---|
| 干净环境（`env -i PATH HOME USER`） | 退出码 0，真实返回 |
| 父会话环境原样传递（Keel 在 Claude Code 里被调用） | 退出码 1，stderr `[claude-code:unrecognized_model]` |
| 网关直连 `/v1/messages`（含 `<model>[1m]`） | 200 —— 模型名本身没问题 |

即：**失败点是环境泄漏，不是模型名、不是认证**。认证门禁放行之后仍然会栽在这里。

## 契约 2：一个 Run 的多轮，状态按 handle 身份定位

R-007 的回灌重试发生在**同一个 Run 内**：`HarnessSessionManager.advance` 每轮都用
同一 `run.run_id`，只把幂等键改成 `...#turn<N>`。所以 `run_id` **不能**唯一定位 state：

```ts
// 身份命中：调用方原样传回 startRun 的 handle
const exact = this.byHandle.get(handle)
if (exact !== undefined) return exact
// 退化为「该 run_id 最近的那个」——SessionManager.interrupt 传的是同形副本
let latest: RunState | undefined
for (const v of this.runs.values()) if (v.handle.run_id === handle.run_id) latest = v
return latest
```

轮次是**串行**的，所以「最近插入」就是当前轮。写成「命中第一个就返回」的后果：

- 第 2 轮 `awaitResult` 立刻返回第 1 轮的 promise（实测 12ms "完成"，真实进程还在后台跑）
- `interrupt` 打到已结束的 state 上，`state.proc === null` → 什么都没杀 →
  Run 级墙钟（方案 B）形同虚设，`develop` 实测跑了 24 分钟

## 契约 3：argv 以**当前版本** `--help` / `system.init` 为准

claude 2.1.300 → 2.1.314 的实测漂移：

| 事实 | 记法 |
|---|---|
| prompt 必须**紧跟** `-p` | 放 argv 末位报 `Input must be provided either through stdin or as a prompt argument` |
| `--print` + `stream-json` 必须带 `--verbose` | 否则直接报错 |
| `--permission-mode dontAsk` 会**拒绝** Edit | headless 无人可问 → `auto` 映射到 `acceptEdits` |
| `Write` 在 2.1.314 里**存在且可用** | 2.1.300 曾实测 `--tools Write` 得到空工具列表；那是**该版本 / 该环境**的现象，不是稳定结论。2.1.314 的 `system.init.tools` 含 `Write`，`--tools Bash,Edit,Read,Write` 下 Write 新建文件成功。旧笔记「Write 已不存在」作废，不再作为映射依据 |
| 2.1.314 的清单里**没有** `Grep` / `Glob` / `Agent` | 不要按名字假定只读工具存在；见 §3.1 |

改 Adapter 时先核 `claude --help` 与一次真实 `system.init.tools`，不要照抄 research 或旧任务的版本快照。

### 3.1 工具清单（toolInventory）与别名

2026-11-10 在 claude 2.1.314 实测到的 `system.init.tools`：

```
Task,Bash,CronCreate,CronDelete,CronList,DesignSync,Edit,EnterWorktree,ExitWorktree,
ListAgents,LSP,Monitor,NotebookEdit,PushNotification,Read,ReportFindings,ScheduleWakeup,
SendMessage,Skill,TaskStop,ToolSearch,WebFetch,WebSearch,Workflow,Write
```

| 传入值 | argv 实际值 | 说明 |
|---|---|---|
| `read` / `write` / `edit` / `bash` | `Read` / `Write` / `Edit` / `Bash` | Keel 内部名 |
| `Read` / `Edit` / `Write` / `Bash` / `Task` 等原生名 | 原样 | 必须出现在清单里，否则拒绝 |
| `grep` / `find` / `ls` | 原生 `Grep`/`Glob`/`LS`；缺省拒绝，显式 `allowShellFallback` 才是 `Bash` | 本版本没有只读检索工具；**回退会拿到 shell**，不是只读，不能静默发生 |
| `delegate` | `Task`；清单有 `Agent` 时 `Agent` | 两者都没有 → 拒绝 |

- 清单由构造参数 `toolInventory` 给出，缺省 `CLAUDE_TOOL_INVENTORY_2_1_314`。
  未来 harness 用 `Task` 还是 `Agent` 由这个参数显式选择，不靠猜。
- 任意未知值、或清单里不存在的原生名，在 `startRun` **之前**返回
  `CAPABILITY_UNSUPPORTED`：不 spawn、不传 CLI、不静默变空清单。
- 去重按解析后的真实名做，保留首次出现顺序（`['read','Read']` → `Read`）。
- `buildClaudeArgv` 保持 `string[]` 返回；已解析的清单经 `opts.tools` 传入，
  适配器内不走抛异常路径。
- `allowShellFallback` 缺省 `false`。未来清单里出现原生 `Grep`/`Glob`/`LS` 时优先原生；
  当前 2.1.314 没有，只读 profile 会明确失败，不会悄悄拿到 Bash。

### 3.2 `--tools` 与 `--allowedTools` 不是一回事

| 参数 | 语义 |
|---|---|
| `--tools` | 本次可用的工具**全集**（精确清单）。始终传；空清单传 `--tools ''`（help：禁用全部工具） |
| `--allowedTools` | **预授权**（不弹权限请求），不是可用清单；不会把清单外的工具加进来 |

所以 `deny_unlisted` **必须两者同传**：只传 `--allowedTools` 是「自动授权已列工具」，
`--tools` 里的全集仍然存在，并不是白名单。

| mode | `--permission-mode` | `--tools` | `--allowedTools` |
|---|---|---|---|
| `manual` | `manual` | 清单 | 不传 —— headless 里需要审批的调用被拒绝，这是 manual 的诚实语义 |
| `accept_edits` | `acceptEdits` | 清单 | 仅当清单含 `Bash` 时传同清单（编辑由 mode 自动接受） |
| `auto` | `acceptEdits` | 清单 | 传同清单 —— headless 无人可问，不传就是「Bash 实际会被拒」而不是已授权 |
| `deny_unlisted` | `manual` | 清单 | 传同清单 |

`auto` 映射 `acceptEdits` 只解决 Edit 的自动接受（`dontAsk` 会拒绝 Edit）；
Bash 的自动执行必须靠同清单 `--allowedTools` 兑现，不能假定 mode 已经授权。

### 3.3 `--bare` 的语义边界

`--bare` 让子 claude 跳过自动发现与同步：hooks、LSP、插件同步，并且不读 OAuth 与
系统钥匙串。按仓库已有实测记录，它**不影响** `~/.claude/settings.json` 的 `env`
（网关配置仍生效）。它**不是** OS 级或网络级隔离：
不限制工具能访问的路径，也不阻断网络。`CAP-UNTRUSTED_WORKSPACE` 的实际边界是
worktree 隔离 + `--tools` 精确清单 + 权限模式；不要把 `--bare` 说成沙箱。

### 3.4 Pi 1.5.1

Pi 走原生 `pi --print --mode json`，不继承 OMP 参数。`untrusted` 工作区关闭扩展、
skills、prompt 模板、context 文件与 MCP 自动发现，并加 `--no-approve`；
需要的能力只能经构造参数显式 `extensions` 加载。

| 传入值 | argv 实际值 | 说明 |
|---|---|---|
| `read` / `grep` / `find` / `ls` / `edit` / `write` / `bash` | 同名 | Pi 内置工具；`grep`/`find`/`ls` 默认关闭，`--tools` 会显式启用 |
| 扩展工具（如 `Agent`） | 同名 | 必须同时出现在 `trustedTools` 与显式 `extensions`，否则 `startRun` 前拒绝 |

- `PiAdapter` 缺省只从用户作用域发现固定的 `@tintinweb/pi-subagents`
  （`$PI_AGENT_DIR/npm/node_modules/...`，默认 `~/.pi/agent`）。找到后会用显式 `-e`
  加载 `src/index.ts`（缺失时退回 `dist/index.js`），并把 `Agent`、
  `get_subagent_result`、`steer_subagent` 记入真实 inventory；不会读取目标仓库的
  `.pi/settings.json` 或其它仓库内扩展。构造参数 `autoSubagents: false` 可关闭这条默认。
- `extensions` 与 `trustedTools` 必须由同一个受信来源一起给出；只给 `trustedTools`
  不给 `extensions` 会直接失败，不会因为父级有 `Agent` 就假定扩展已经加载。
- Pi 没有 `CAP-RESUME`，也不宣称原生结构化输出；能力级别为 L0。
- 完成判定要求 `agent_settled` 且 `aborted=false`、末条 assistant `stopReason=stop`、
  没有未配对工具调用、没有未结束自动重试；只有 `agent_end` 不算完成。
- 真实工具链已用隔离临时目录验证 `Read → Write → Edit → Bash`，证据在
  `.keel/coordination/2026-11-10/full-delivery/adapter-pi-*-evidence.json`。
- `--tools` 只是模型可见工具 allowlist，不是 OS 隔离；`bash` 仍按当前用户权限访问
  文件系统与网络，不可信仓库仍需要外层 worktree / 沙箱。
- `pi-subagents` 的 `Agent` 工具不等于权限隔离：子代理按自己的 `tools:` 运行，
  父级 allowlist 不自动继承。当前不把 managed 子代理边界当作已验收。

## 契约 4：中断 / 失败也要上报**已见到**的 usage

`awaitResult` 的非 `SUCCEEDED` 分支（`TIMEOUT` / `CANCELLED`）**不是**「没花钱」：

| Adapter | 已经能拿到的用量 | 取法 |
|---|---|---|
| omp | 增量解析器里的 `turn_end` / `message_end` | `parser.end().usage`（与 SUCCEEDED 同口径） |
| claude | `assistant` 事件的 `message.usage` | 按 `message.id` 去重累加；有 `result` 时用 result 聚合值 |
| human | 无 token 概念 | 保持 `null` + `unavailable` |

硬编码全 `null` 的 abort 分支会让六次 `TIMEOUT` 的 tokens 全空，
C-002 对最烧钱的重试失明（issue #74）。从未上报时才允许 `null`；
**任何时候都不补 0**（`docs/08-cross-cutting.md` §3.1）。

<!-- 反例：把 omp abort 的 usage 改回硬编码 null → adapters.test.ts「中断前的 usage 入账」变红 -->

---

## 失败模式与测试锚点

| 失败模式 | 守它的测试 | 反例验证 |
|---|---|---|
| 宿主运行时变量泄漏给子进程 | `claude-code.test.ts` ·「spawn cwd … env 已剔除宿主运行时变量」+「sanitizeClaudeEnv」 | 去掉 `env:` → 红（`PROVIDER_MANAGED_BY_HOST` 出现） |
| 多轮串 state | `claude-code.test.ts` ·「同 run_id 多轮 —— 不得串到上一轮」 | `find` 改回「命中第一个」→ 红（第 2 轮拿到「第一轮」） |
| 墙钟打到陈旧 state | 同上 ·「interrupt 打到**当前轮**的进程」 | 同上 → `killSpy` 命中的是 `procs[0]` 的 pid → 红 |
| argv 与 CLI 版本不符 | `buildClaudeArgv` 各条（prompt 位置 / `--verbose` / 工具与权限映射） | 把 `write` 重新映射回 `Edit` →「Keel 工具名映射…」红 |
| 未知工具被静默传到 CLI 后丢失 | 「未知值在 startRun 前拒绝」+「原生名不在清单里也拒绝」 | 去掉 `startRun` 的 `resolveClaudeTools` → `spawn` 被调用 → 红 |
| `deny_unlisted` 只靠 `--allowedTools`（自动授权而非白名单） | 「deny_unlisted → `--tools` 精确清单 + `--allowedTools` 同清单」+「`--allowedTools` 不会把清单外工具带进来」 | 改回只 push `--allowedTools` → 无 `--tools` → 红 |
| `auto` 实际只是 prompt，Bash 未预授权 | 「auto 用同清单 `--allowedTools` 预授权」 | 删掉 `auto` 分支 → 无 `--allowedTools` → 红 |
| `grep` / `find` / `ls` 被当成只读工具 | 「grep / find / ls 默认拒绝，必须显式允许 Bash 回退」+ 清单缺 Bash 时拒绝 | 默认改回 Bash → 只读用例拿到 shell → 红 |
| `Task` / `Agent` 由版本猜测 | 「delegate 按清单选 Task 或 Agent」+「构造参数 toolInventory 选择」 | 写死 `Task` → `Agent` 清单用例红 |
| `Write` 能力被旧结论掩盖 | 单测「Write 在当前清单里是真实工具」；真实集成在 `KEEL_REQUIRE_CLAUDE=1` 下用 `--tools Write` 新建文件并断言内容 | 改回映射 `Edit` → 单测红；真机下文件不会出现 |

**env 隔离必须用注入的 `spawnFn` 断言 `opts.env`**，不要起真进程：
断言对象是「子进程实际收到什么」，不是「我以为传了什么」。
