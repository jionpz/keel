# Executor Isolation（执行器隔离门禁）

> 状态：JT-02A 第一个可执行切片。已实现环境 allowlist、容器规格校验和真实 Docker
> 负例探针，并接入独立的 CI job；**尚未接入 managed runtime，也未开放任何写工具**。

本门禁检查 managed 写执行器的启动边界：环境是否只有 allowlist、容器是否只有
一个只读 workspace 挂载、workspace 是否为独立 git 顶层、宿主 HOME/gh/SSH 是否
不挂载、容器是否没有外部网络。它**不宣称**已经证明任意真实 agent 看不到其他项目
目录；真实 Pi/Claude/OMP agent 级负例仍未完成，managed 代码修改、push、PR 动作
继续关闭（issue #99）。

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

当前已有 adapter 的 `sanitizeClaudeEnv` 仍是“剔除宿主信号”的黑名单，服务于
本机 adapter 兼容；本文件定义的 allowlist 是新 managed 隔离门禁，两者尚未合并。

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

## 5. 尚未覆盖

- 未把本门禁接入 `src/control/managed/` 或任何 managed runtime 写路径；写工具仍关闭。
- 尚未对 Pi、Claude Code、OMP 各跑一次真实 agent 级负例；当前只验证可复用的环境、
  独立 git workspace 与容器启动规格，不是三种 CLI 的最终 managed 验收。
- 容器内没有模型推理凭据与外部网络，因此不能在其中调用模型；未来需要单独的受信
  推理通道，不能把 GitHub 凭据或宿主 HOME 作为交换条件。
- Docker daemon、容器运行时和宿主机仍是信任根；本门禁不宣称虚拟机级隔离或
  生产级多租户隔离。
