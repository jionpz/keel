# Harness Adapter（Execution → 真实 CLI）

> 记录**实际**做法与踩过的坑。来源：`10-25-claude-auth-config` 任务的真机跑通
> （2026-10-25，本机 claude 2.1.300 + magpie 网关）。
> 代码在 `src/execution/adapters/{claude-code,omp,human}.ts`。

---

## Scope / Trigger

Adapter 是 Keel 唯一**真正起子进程**的地方。三条契约在这里最容易破：

| 契约 | 破了会怎样 |
|---|---|
| 子进程必须看到**用户配置**，不能看到**父会话运行时** | 同一条本机能跑的配置，经 Keel 跑就失败（实测：`unrecognized_model`，退出码 1） |
| 同一 Run 的多轮必须互不串状态 | 第 2 轮 `awaitResult` 拿第 1 轮结果，墙钟 watchdog 打空，Run 无上限地跑 |
| argv 必须对得上**当前版本**的 CLI | 静默降级（`--tools Write` 得到空工具列表）或直接报错 |

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

## 契约 3：argv 以**当前版本** `--help` 为准

claude 2.1.300 相对 2.1.222（本任务 research 记录的版本）的漂移：

| 事实 | 记法 |
|---|---|
| prompt 必须**紧跟** `-p` | 放 argv 末位报 `Input must be provided either through stdin or as a prompt argument` |
| `--print` + `stream-json` 必须带 `--verbose` | 否则直接报错 |
| `Write` 工具**已不存在**，可用的是 `Bash` / `Edit` / `Read` | `--tools Write` 不报错，但得到空工具列表（静默降级）→ Keel `write` 映射到 `Edit` |
| `--permission-mode dontAsk` 会**拒绝** Edit | headless 无人可问 → `auto` 映射到 `acceptEdits` |

改 Adapter 时先去 `claude --help` / `omp --help` 核一遍，不要照抄 research 里的旧版本。

---

## 失败模式与测试锚点

| 失败模式 | 守它的测试 | 反例验证 |
|---|---|---|
| 宿主运行时变量泄漏给子进程 | `claude-code.test.ts` ·「spawn cwd … env 已剔除宿主运行时变量」+「sanitizeClaudeEnv」 | 去掉 `env:` → 红（`PROVIDER_MANAGED_BY_HOST` 出现） |
| 多轮串 state | `claude-code.test.ts` ·「同 run_id 多轮 —— 不得串到上一轮」 | `find` 改回「命中第一个」→ 红（第 2 轮拿到「第一轮」） |
| 墙钟打到陈旧 state | 同上 ·「interrupt 打到**当前轮**的进程」 | 同上 → `killSpy` 命中的是 `procs[0]` 的 pid → 红 |
| argv 与 CLI 版本不符 | `buildClaudeArgv` 各条（prompt 位置 / `--verbose` / 工具与权限映射） | —— |

**env 隔离必须用注入的 `spawnFn` 断言 `opts.env`**，不要起真进程：
断言对象是「子进程实际收到什么」，不是「我以为传了什么」。
