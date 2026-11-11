# Executor Isolation（执行器隔离门禁）

> 状态：环境 allowlist、容器规格校验、真实 Docker 负例探针、Pi/Claude Code/OMP
> 的真实 agent 级凭据负例，以及 managed ticket worker 的逐次隔离 HOME/TMPDIR 已接入。
> managed 写执行现在只允许本机模型网关；**宿主文件系统仍由运行进程的用户权限约束，
> 容器执行器尚未接入 managed runtime**。

本门禁检查 managed 写执行器的启动边界：环境是否只有 allowlist、容器是否只有
一个只读 workspace 挂载、workspace 是否为独立 git 顶层、宿主 HOME/gh/SSH 是否
不挂载、容器是否没有外部网络。它**不宣称**已经证明任意真实 agent 看不到其他项目
目录：容器探针证明挂载与网络边界，agent 级探针证明隔离 HOME/配置下三种 CLI 拿不到
GitHub/SSH 凭据。managed 写执行已经通过 outbox / PR 网关开放，但运行仍在宿主用户
权限内，不能把本文件当作容器级或多租户级隔离证明。

## 1. 不变量

1. 子进程环境从显式 allowlist 构造，不复制宿主 `process.env`。
2. GitHub 凭据、模型凭据、SSH agent、宿主会话身份与 harness 运行时变量全部不可见。
3. `HOME` 与 `TMPDIR` 必须同时由容器规格显式提供，且只能位于容器 `/tmp`。
4. workspace 必须是独立 git 顶层，并以只读方式挂载到 `/workspace`；`/tmp` 是
   独立 tmpfs；根文件系统只读。
5. 容器使用非 root 用户、`--network none`、`cap-drop ALL`、`no-new-privileges`。
6. 实际 Docker 配置和容器内负例都要留下结构化证据，不能用设计文档代替运行结果。

## 2. 环境 allowlist

实现位于 `src/execution/isolation/executor-env.ts`，由 `src/execution/index.ts` 导出，
供 Pi、Claude Code、OMP 在启动前共同调用。

```ts
buildExecutorEnv(source, { home: '/tmp/home', tmpdir: '/tmp' })
```

- 只保留 `PATH`、`LANG`、`LC_ALL`、`LC_CTYPE`、`LC_MESSAGES`、`TZ`、`TERM`、
  `NO_COLOR`。
- `HOME`、`TMPDIR` 不从 `source` 复制，必须同时显式传入；值必须在容器 `/tmp` 下。
  `buildExecutorEnv` 在缺少任一项时直接失败，不返回 PATH-only 环境。
- `findExecutorEnvViolations(env)` 用于启动前复检：缺少 HOME/TMPDIR、不在
  allowlist、值为空、HOME/TMPDIR 越界、键名命中凭据/会话模式都拒绝。
- 函数不读 `process.env`、不修改输入；调用方必须显式传入来源。

凭据模式包括 `*_TOKEN`、`*_SECRET*`、`*_PASSWORD*`、`*_API_KEY`、`*_AUTH*`、
`GITHUB*`、`GH_*`、`SSH_*`、`*_ASKPASS` 等。即使未来误把某个凭据键加进
allowlist，`findExecutorEnvViolations` 仍会拒绝。

`src/execution/isolation/managed-env.ts` 负责把门禁接到实际执行：

- `prepareManagedExecutorEnv` 每次调用创建独立的 `/tmp/keel-exec-*`、`home`、`tmp`；
- 子进程环境只由 `buildExecutorEnv` 生成，`HOME`/`TMPDIR` 不继承宿主；
- Pi 只写最小 `~/.pi/agent/models.json`（本机网关 provider + 单个模型），并复制
  Pi 子代理扩展及其 npm 依赖到隔离 HOME；
- Claude 只写最小 `~/.claude/settings.json`（本机网关 URL 与占位 token）；
- OMP 只写选中的本机网关 provider 块与 `config.yml`，拒绝 keychain 命令；
- 外部 `baseUrl`、真实 API key、keychain `!command` 都在启动前拒绝。

Pi / Claude Code / OMP 的 adapter 现在都接受显式 `env`，并把该对象直接传给
`spawn`；省略时才保留本机普通 CLI 的继承行为。`sanitizeClaudeEnv` 仍是兼容层，
managed 路径传入的已经是 allowlist 环境，因此它不会再放大边界。

## 3. 容器规格门禁

实现位于 `src/execution/isolation/container-spec.ts`：

```ts
findIsolationViolations(spec, policy)
await inspectWorkspaceIsolation(spec.workspace, policy)
```

`spec` 必须满足：

- `network === 'none'`
- `user` 非 `0` / `root`
- `readOnlyRoot === true`
- 只有一个挂载：`workspace -> /workspace`，且 `readOnly === true`
- 只有一个 tmpfs：`/tmp` 带 `rw,noexec,nosuid,nodev`
- `capDrop` 含 `ALL`，`noNewPrivileges === true`
- `pidsLimit` 在 `1..256`
- env 通过 `findExecutorEnvViolations`

同步校验拒绝 `/`、共享临时目录根（`/tmp`、`/var/tmp`、`/dev/shm`）以及所有受保护
路径与 workspace 的非法重叠。宿主 HOME 只拒绝等于 HOME 或其祖先；`~/.config/gh`、
`~/.ssh` 和 Docker socket 同时拒绝等于、祖先和后代，因此 `~/.ssh/task`、
`~/.config/gh/...` 不能被选作 workspace。共享临时目录的子目录不会被同步校验直接
拒绝，但仍须通过下面的异步检查。

`inspectWorkspaceIsolation` 是 async 门禁：对 workspace 做 `realpath`，拒绝 workspace
自身是符号链接、解析后落入受保护路径的情况；随后运行
`git -C <real> rev-parse --show-toplevel`，要求输出恰好等于 `<real>`。因此普通
目录如果只是父仓库中的子目录、或只是指向别处的别名，都不能通过。独立 git worktree
（包括共享临时目录下的真实 worktree）可以继续进入容器规格校验。

Docker 自己注入的 `/etc/hosts`、`/etc/hostname`、`/etc/resolv.conf` 和
`/dev/shm` 是运行时基础设施，不属于任务挂载。探针只允许 Docker 针对当前容器 ID
生成的 `/etc/hosts`、`/etc/hostname`、`/etc/resolv.conf`，并要求它们只读；不会按
目标路径放行任意挂载。实际 `Mounts` 中必须恰好有一个任务 bind 指向 workspace 且
`RW=false`。

## 4. Docker 探针

```sh
pnpm run check:isolation
```

探针会：

1. 先跑两个隔离单测，再构建 `keel-jt02a-isolation:gh-2.96.0`；基础镜像按 digest
   固定，GitHub CLI 版本固定并校验发布包 SHA256。
2. 在 `.keel/jt02a-isolation/<timestamp>/workspace` 创建独立 git 测试仓库，并执行
   `inspectWorkspaceIsolation`。
3. 用 allowlist 环境启动 `--network none`、非 root、只读根文件系统容器。
4. 在宿主侧读取 `docker inspect`，核对真实网络、用户、挂载、tmpfs、capability、
   device、bind、security option 与只读根文件系统。
5. 在容器内执行负例，并输出 `.keel/jt02a-isolation/<timestamp>/probe.json`。

宿主侧断言包括：`NetworkMode=none`、`ReadonlyRootfs=true`、`CapAdd=[]`、
`Devices=[]`、`Binds=[]`、`SecurityOpt` 精确包含
`no-new-privileges:true`、`CapDrop` 包含 `ALL`；任务 bind 恰好一个，源为 workspace
目标为 `/workspace` 且 `RW=false`；若 Docker 自动生成 `/etc/hosts`、`/etc/hostname`、
`/etc/resolv.conf`，只接受当前容器 ID 生成的只读 bind。

容器内断言包括：

| 断言 | 负例 / 控制 |
|---|---|
| env 精确等于 allowlist + HOME/TMPDIR | 使用 `/usr/bin/env -i` 启动探针，证明宿主变量没有被继承 |
| canary token 不存在 | 宿主侧注入 sentinel 值，容器内环境 dump 检查值未出现且 token 类键为空 |
| SSH/GitHub 变量不存在 | 容器内环境 dump 显式检查 SSH、GitHub 键位为空 |
| HOME 在 tmpfs | `HOME=/tmp/home`，不是宿主 HOME |
| workspace 只读 | 读取 `README.md` + `git status` 成功作为控制；写文件必须失败 |
| gh 配置/token 不可用 | `gh --version` 成功作为控制；`gh auth token` 必须失败且 stdout 为空 |
| git push 不可用 | 真实仓库 URL（`https://github.com/jionpz/keel.git`）作为 remote；`--network none` 下 push 必须非零退出 |
| GitHub API 不可用 | `curl --version` 成功作为控制；无 token 请求 `https://api.github.com/user` 必须非零退出 |
| 无默认路由 | `/proc/net/route` 不得有默认路由 |
| 无宿主配置挂载 | `/root`、`/home`、`/Users` 不得出现在 mount table |

探针不保存 `gh auth token`、网络响应或 `git push` 的原始输出，只记录退出状态、
signal、stdout/stderr 字节数；避免“为了取证反而泄露凭据”。

Docker 不可用、镜像构建失败、任一宿主检查或容器负例失败时，脚本以退出码 1 退出，
并保留 `probe.json`（若已进入探针阶段）。**不得把失败解释为通过，也不得静默 skip。**
CI 的 `isolation` job 运行在 `ubuntu-latest`，先显式检查 `docker version`，再执行
`pnpm run check:isolation`；它不依赖 `pnpm run check` 是否包含 Docker 探针。

## 5. Agent 级负例

```sh
pnpm run check:agents
```

探针启动本地 OpenAI / Anthropic 兼容 stub，让真实 CLI 在不接触真实模型凭据和外部
推理网络的情况下按固定顺序执行工具：

1. `env`
2. `gh auth token`
3. `cat "$HOME/.config/gh/hosts.yml"`
4. `curl ... https://api.github.com/user`
5. `git push` 到真实 GitHub 仓库

探针现在调用与 managed worker 相同的 `prepareManagedExecutorEnv`：每个 harness 使用
独立临时 `HOME`、`TMPDIR` 和最小模型配置；宿主侧显式注入
`KEEL_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` / `SSH_AUTH_SOCK` 作为 sentinel，
再断言子进程 `env` 中不存在这些键。子进程环境只由显式 allowlist 构造，不继承宿主
`process.env`。
`git push` 前显式清空 credential helper，并禁用终端提示、askpass 和 SSH agent。

判定要求：

- `env` 成功，但不得出现 `GITHUB_TOKEN`、`GH_TOKEN`、`KEEL_GITHUB_TOKEN`、
  `GITHUB_ENTERPRISE_TOKEN`、`SSH_AUTH_SOCK`、`SSH_AGENT_PID`；`HOME`/`TMPDIR`
  必须等于隔离目录。
- 其余四项必须失败；失败文本必须匹配认证失败、配置文件不存在或推送拒绝，不能只
  凭非零退出码通过，避免“命令不存在”被误判为隔离成功。
- GitHub API 只接受 `401` / `403` 或明确的网络失败；`git push` 必须非零退出。
- 证据 JSON 只记录退出码、输出字节数、判定和原因，不保存原始输出或 token。

2026-11-11 本地实测：Pi 1.5.1、Claude Code 2.1.314、OMP 18.11.1 全部 PASS；
宿主 sentinel 凭据没有进入任何一个 harness。adapter 层另有 `spawnFn` 单测，
断言显式 `env` 原样传给子进程且不含 sentinel。

边界：agent 级探针在宿主以隔离 HOME/配置运行，**不证明**绝对路径（如
`/Users/<user>/.ssh`）不可读；第 4 节容器探针只证明容器规格可以做到挂载边界，
managed runtime 尚未使用该容器。生产多租户仍需更强的系统级沙箱。

## 6. 已接入与残余边界

- `managed ticket worker` 与 managed 只读推理已通过 `prepareManagedExecutorEnv`
  接入本门禁；每个 stage attempt / 天问调用使用独立 HOME/TMPDIR，adapter 用显式
  env 启动子进程。
- managed 写执行只接受本机模型网关（`127.0.0.1` / `localhost` / `::1`）；外网
  provider、真实 API key 与 keychain `!command` 会在认领后、spawn 前拒绝。
- **未接入容器执行器**：agent 仍以宿主用户身份运行，绝对路径读取、宿主已授权文件
  和网络出口没有被系统级沙箱封死。当前能证明的是“凭据不通过环境继承”，不是
  “只能看到任务 worktree”。因此不能宣称满足容器/独立低权限运行用户这一条。
- 容器内没有模型推理凭据与外部网络，因此不能直接在其中调用模型；未来需要单独的
  受信推理通道，不能把 GitHub 凭据或宿主 HOME 作为交换条件。
- Docker daemon、容器运行时和宿主机仍是信任根；本门禁不宣称虚拟机级隔离或
  生产级多租户隔离。
