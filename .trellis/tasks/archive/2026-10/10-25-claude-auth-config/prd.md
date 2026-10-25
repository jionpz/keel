# Claude Code 认证门禁对齐本机网关配置

## Goal

让 `--harness claude` 的前置认证检查与**本机实际配置**一致。

本机 Claude Code 走 magpie 网关：`ANTHROPIC_BASE_URL=http://127.0.0.1:3425`
与 `ANTHROPIC_AUTH_TOKEN` 写在 `~/.claude/settings.json` 的 `env` 里。
而 `requireAnthropicApiKeyForBare()` 硬性要求进程环境里有 `ANTHROPIC_API_KEY`
—— 结果是**能跑的配置被自己的闸门挡住**。

## Background（本次实测）

| 场景 | 结果 |
|---|---|
| `env -i HOME=$HOME PATH=$PATH claude --bare -p "回复 OK"` | **成功**，返回 `OK`，exit 0 |
| 空 HOME（不读 settings） | `Not logged in · Please run /login` |
| 空 HOME + `ANTHROPIC_AUTH_TOKEN` | 成功 |
| 空 HOME + `ANTHROPIC_API_KEY` | 成功（网关两种头都收） |
| `claude auth status --json`（真 HOME） | `loggedIn: true`，`authMethod: oauth_token` |
| `claude auth status --json`（空 HOME） | `loggedIn: false`，`authMethod: none` |

结论：`--bare` 跳的是 hooks / LSP / 插件同步与 OAuth·钥匙串读取，
**不影响** settings 里的网关环境变量，也不影响 `auth status` 的本地判定。
所以 `auth status` 是一个零网络、低成本的认证就绪信号。

## Requirements

- R1 判定顺序：`ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → `claude auth status --json` 的 `loggedIn`
- R2 探测**不可判定**（缺二进制、超时、输出不可解析）时不误报 `AUTH_FAILED`，
  交给 `requireClaudeBinary` 报 `HARNESS_UNAVAILABLE`
- R3 保留「先于 ingest 失败」的性质：确实未登录时仍 `AUTH_FAILED` 且零写入
- R4 单测可注入探测函数，不依赖本机是否安装、是否登录 claude（否则 CI 与本机会得到不同结论）
- R5 错误文案更新：不再宣称「只认 ANTHROPIC_API_KEY」，改为列出三条可接受路径
- R6 **宿主运行时变量不得进子 claude**：Keel 自己在 Claude Code 会话里被调用时，
  子进程会继承 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` / `CLAUDE_CODE_MODEL_CATALOG`
  等「由宿主托管 provider」的信号，以及 `CLAUDE_CODE_MESSAGING_SOCKET` 这类能反向
  连回父会话的 IPC。必须在 spawn 前剔除；凭据（`ANTHROPIC_*`）与其余环境原样保留
- R7 **同一 Run 的多轮不得串结果**：R-007 的回灌重试每轮都复用同一 `run.run_id`，
  只把幂等键改成 `...#turn<N>`。`awaitResult` / `interrupt` 必须命中**当前轮**，
  不能命中上一轮那个已结束的 state

## 实测记录（2026-10-25，本机 claude 2.1.300 + magpie 网关）

| 现象 | 结论 |
|---|---|
| `keel run-task --harness claude`（父会话环境原样传递） | `pm` 三次 `HARNESS_UNAVAILABLE`，stderr 为 `[claude-code:unrecognized_model]`，退出码 1 |
| 同一 argv 用 `env -i` 干净环境跑 | 退出码 0，真实返回 |
| 单独探针：`env -u ANTHROPIC_*`（保留 `CLAUDE_CODE_*`） | 复现退出码 1 |
| 网关直连 `/v1/messages`（带 `<model>[1m]`） | 200，模型名不是问题 |
| 假二进制模拟「第一轮结束、第二轮挂住」 | 修复前：第二轮 12ms 就"完成"，真实进程仍在后台；修复后：墙钟在 15s 正确打断当前轮 |

即：同一条「本机能跑的配置」，失败点是**环境泄漏 + 多轮串 state**，
不是认证门禁本身。认证门禁（R1–R5）事实上是这次跑通的前置，两个 Adapter
缺陷是跑通后才暴露的。

## Acceptance Criteria

- [x] AC1：`pnpm run check` 全绿
- [x] AC2：单测覆盖 env key / env token / probe=true / probe=false / probe=null 五条路径
- [x] AC3：真机 `run-task --harness claude` 通过门禁并跑完一个任务（临时仓库）——
  `1d891a16` 一路到 **S-DONE**：pm → rfc_draft → develop(实际改 README.md +35 行并提交)
  → qa → review → S-PR_OPEN → S-DONE，5 个 run 全 SUCCEEDED，合计 $1.27。
  ⚠️ 墙钟用的是 `runTask({ wallClockS: 600 })`（**CLI 还没有 `--wall-clock` 旗标**，另开任务）
- [x] AC4：run-issue 的「未登录 → AUTH_FAILED 零写入」语义不变
- [x] AC5：单测证明宿主运行时变量被剔除、其余环境原样保留
- [x] AC6：单测证明同 `run_id` 的第二轮拿到自己的结果，`interrupt` 打中当前轮进程

## Out of Scope

- 改 `--bare` 策略（untrusted worktree 仍然强制）
- 读取 / 传递 magpie 的 token 值（只依赖 claude 自身配置，不由 Keel 持有凭据）
- 支持 Bedrock / Vertex 等第三方 provider 的凭据探测
