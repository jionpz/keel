# GitHub Provider（REST 适配器）

> 来源：`11-03-ghes-host-support`（issue #69）。记录 `src/fact/github-provider.ts` 的**实际**契约。
> 目标：host 解析只有一份实现；GHES 与 github.com 走同一套请求路径。

---

## Scenario: GitHub host 解析与 API root 选择

### 1. Scope / Trigger

- 触发：新增 `KEEL_GITHUB_API_ROOT` 环境变量与 GHES host 支持。
- 影响面：`parseRemoteUrl` / `ownerRepo` / `parseIssueUrl` / `GitHubProvider` 的全部 REST 请求。
- 风险：企业内网 remote 若被静默打到 `api.github.com`，属于数据外流。

### 2. Signatures

> 模块归属：URL / host 解析在 `src/fact/github-remote.ts`，凭据读取在
> `src/fact/github-auth.ts`；`github-provider.ts` **re-export** 它们，
> 现有调用点仍从 provider import。拆分原因：`github-auth → provider → github-auth`
> 会构成循环依赖（`no-circular` 必红），且 host 解析必须保持单份实现。

```ts
export interface ParsedRemote {
  readonly host: string        // 小写，无端口
  readonly owner: string
  readonly repo: string        // 已剥离一次 .git
  readonly remoteUrl: string   // 规范化为 https://<host>/<owner>/<repo>.git
}

export function isGitHubHost(host: string): boolean
export function apiRootForHost(host: string): string
export function parseRemoteUrl(remoteUrl: string): Result<ParsedRemote>
export function ownerRepo(remoteUrl: string): Result<string>
export function parseIssueUrl(url: string): Result<{ remoteUrl: string; number: number }>

class GitHubProvider {
  constructor(opts?: {
    apiRoot?: string
    token?: string | null
    pollIntervalMs?: number
    pollTimeoutMs?: number
    emptySettleMs?: number
  })
  private rootFor(host: string): Result<string>
  private request(
    host: string,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<Result<{ status: number; json: unknown }>>
}
```

### 3. Contracts

**支持的 remote 语法**

- `https://<host>/owner/repo(.git)`
- `http://<host>/owner/repo(.git)`
- `ssh://git@<host>/owner/repo(.git)`
- SCP-like：`git@<host>:owner/repo(.git)`

**host 白名单**

- `github.com`
- `github.*`，但排除 `github.com.*`

其它 host（`gitlab.com`、`ghe.corp.example` 等）一律拒绝：provider 是 GitHub 专用，
把非 GitHub 地址误当 GHES 只会把请求打到错误的服务。

**owner / repo 校验**

- owner：`^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$`
- repo：`^[A-Za-z0-9._-]+$`，且不为 `.` / `..`
- path 归一后必须恰好两段；`.git` 只剥离一次

**API root 优先级**

```
opts.apiRoot               （测试/显式注入，最高）
  > KEEL_GITHUB_API_ROOT   （部署配置，构造时读一次）
  > apiRootForHost(host)   （缺省推导）
```

- `apiRootForHost('github.com')` → `https://api.github.com`
- `apiRootForHost('<其它 host>')` → `https://<host>/api/v3`
- 空白或非 `http(s)` 的 `apiRoot` / `KEEL_GITHUB_API_ROOT` **不是「未设置」**：
  返回 `WORKSPACE_ERROR`，绝不静默回退公网。

### 4. Validation & Error Matrix

| 条件 | 结果 |
|---|---|
| 协议不是 http / https / ssh（如 `file://`） | `WORKSPACE_ERROR` |
| host 不在白名单 | `WORKSPACE_ERROR` |
| path 不是恰好两段 / owner/repo 非法 / `..` | `WORKSPACE_ERROR` |
| Issue URL 不是 `/owner/repo/issues/<n>` | `WORKSPACE_ERROR` |
| `opts.apiRoot` 空白或非 http(s) | 每次请求 `WORKSPACE_ERROR` |
| `KEEL_GITHUB_API_ROOT` 空白或非 http(s) | 每次请求 `WORKSPACE_ERROR` |
| 缺少 token | `AUTH_FAILED` |
| HTTP 401 / 403 | `AUTH_FAILED` |
| HTTP 404 | `NOT_FOUND` |
| HTTP 429 / 5xx / 网络失败 | `HARNESS_UNAVAILABLE` |

### 5. Good / Base / Bad Cases

- **Good**：`https://github.example.com/acme/widget.git`
  → `host=github.example.com`，API 根 `https://github.example.com/api/v3`
- **Base**：`https://github.com/acme/widget.git`
  → `host=github.com`，API 根 `https://api.github.com`（与改造前逐字节一致）
- **Bad**：`https://gitlab.com/acme/widget` → `WORKSPACE_ERROR`
- **Bad**：`file:///tmp/repo` → `WORKSPACE_ERROR`

### 6. Tests Required

`src/fact/github-provider.test.ts`：

- `parseRemoteUrl` / `ownerRepo` 表驱动：
  github.com、GHES、`ssh://`、SCP-like、`http://`、尾斜杠、`.git`、
  `..`、单段路径、三段路径。
- `parseIssueUrl`：github.com、GHES、尾斜杠、非 issues URL、`pull/1`。
- `apiRootForHost`：`github.com`、`GitHub.com`（大小写）、GHES host。
- stub server：
  - 未设环境变量 → GHES 请求打到 `https://<host>/api/v3/repos/...`
  - `KEEL_GITHUB_API_ROOT` 覆盖 host 推导
  - 空白环境变量 → `WORKSPACE_ERROR` 且 **fetch 未被调用**
  - `opts.apiRoot` 注入仍是最高优先级

### 7. Wrong vs Correct

**Wrong**：调用方另写 host 正则或 API 根

```ts
const API_ROOT = 'https://api.github.com'
fetch(`${API_ROOT}/repos/${slug}/issues/${n}`)
```

**Correct**：统一走 `parseRemoteUrl` + `rootFor`

```ts
const parsed = parseRemoteUrl(remoteUrl)
if (!parsed.ok) return parsed
const root = this.rootFor(parsed.value.host)
if (!root.ok) return root
```

---

## 调用方约定

- `register-repo` 用 `normalizeRemoteUrl` 做**宽松比对**（只去尾斜杠与 `.git`），
  不校验 host；真正校验发生在 `GitHubProvider`。
- `ingest-issue` 的 `parseIssueUrl` 返回规范化 https remote，
  后续 `resolveRepo` 用同一个 `normalizeRemoteUrl` 比对。
- 不得在 `register-repo` / `ingest-issue` 里新增第二套 host 正则。

---

## required checks 观察（JT-02E）

`GitHubProvider.observeRequiredChecks()` 是 managed `pr_ready` 的只读事实入口：

1. `GET /repos/{owner}/{repo}/pulls/{number}` 读取当前 head SHA 与 head/base ref；
2. 按该**完整 SHA** 分页读取 `check-runs` 与 `commit statuses`；
3. 同一 required 名称只保留最新一次 check-run / status 观察；
4. 再读一次 PR；head SHA、head/base ref 或状态在观察期间变化则返回 `CONFLICT`，
   不产生可复用证据。

required 名称未出现在响应中时返回空事实，由控制层记录 `missing` 并等待；
provider 不把“无人上报”解释成 success。check-run 的 `head_sha` 与 PR head 不一致时
返回 `PROTOCOL_ERROR`，防止 SHA-A 的绿色结果挂到 SHA-B。

---

## Scenario: GitHub token 来源与启动期校验（11-05-github-token-source）

### 1. Scope / Trigger

- 触发：token 不再只认 `KEEL_GITHUB_TOKEN`，而是复用本机 `gh` 登录态；
  缺失时在入口启动期失败，而不是跑到 clone / push / API 调用才报
  `could not read Username`。
- 影响面：`src/fact/github-auth.ts`（唯一解析器）、`GitHubProvider`、
  `GitWorkspace`，以及 `run-issue` / `run-task --ci real` / `poller` 三个入口。
- 风险：token 进 argv / 日志 / 错误 detail / 事件；或缺失时前半段流程已产生写入。

### 2. Signatures

```ts
export type TokenResolver = (host: string) => Promise<string | undefined>

export interface TokenResolveDeps {
  readonly env?: NodeJS.ProcessEnv
  readonly runGh?: (host: string) => Promise<string | undefined>  // 测试注入
}

export async function resolveGitHubToken(
  host?: string,          // hostname，不含端口；缺省 github.com
  deps?: TokenResolveDeps,
): Promise<string | undefined>

// GitHubProviderOptions / GitWorkspaceOptions
readonly tokenResolver?: TokenResolver   // 缺省 resolveGitHubToken

// run-task
export async function resolveCiGateway(
  ci: CiMode,
  host?: string,
  tokenResolver?: TokenResolver,
): Promise<Result<GitHubProvider | undefined>>
export async function requireGitHubToken(
  host: string | undefined,
  tokenResolver?: TokenResolver,
): Promise<Result<string>>

// task-workspace
export async function loadTaskRemoteUrl(taskId: string): Promise<Result<string | undefined>>
```

### 3. Contracts

**来源优先级（唯一事实源）**

```
非空 KEEL_GITHUB_TOKEN > 非空 GITHUB_TOKEN > gh auth token --hostname <host>
```

- 空白值等同未设置：`KEEL_GITHUB_TOKEN=''` 不得遮蔽 `GITHUB_TOKEN` 或 `gh` 登录态。
- `gh` 用 `execFile`（无 shell，5s 超时）；gh 不存在 / 未登录 / 超时 / 输出空白
  一律返回 `undefined`，**不抛异常、不把 stderr 带出**（错误文本可能含凭据）。
- 解析器无状态；缓存放在消费方实例（按 host），避免测试互相污染。
- token 会被 `trim()`；带空白的值不进 header。

**消费方**

- `GitHubProvider`：显式 `opts.token`（含 `null`）拥有最高优先级且**绝不**触发
  resolver；否则 `request(host)` 按需解析并缓存在 `Map<host, string>`。
- `GitWorkspace`：只有 `execGit(..., { auth })` 且 remote 是 http(s) 时才解析；
  ssh / file / 解析失败不调用 resolver，也不注入 env。解析结果按 host 缓存，
  并进入 `secrets()` 的脱敏集合 —— gh 来源的 token 不在 `process.env` 里。
- 脱敏集合 = 环境 token + 所有已缓存的 host token（明文 + base64 两种形态）。

**启动期校验位置（全部在任何 ingest / run 创建之前）**

| 入口 | host 来源 | 行为 |
|---|---|---|
| `run-issue` | `parseIssueUrl(issueUrl)` 的 hostname | 未注入 `opts.github` 时先 `requireGitHubToken`；`--ci real` 再走 `resolveCiGateway`，均在 ingest 之前 |
| `run-task --ci real` | task 对应 repo 的 `remote_url`（`loadTaskRemoteUrl`，单条 SELECT） | gateway 创建先于 `loadTaskWorkspace`；`ci !== 'real'` 不解析任何 token |
| `poller` | `listRepos()` 后按 `parseRemoteUrl` 收集唯一 host 集合 | 任一 host 缺 token → 退出码 1，文案列 host 与修复命令；**repos 为空不需要 token**；循环内仍 live 读 repo 列表 |
| `register-repo` | — | 不做预检；clone / fetch 由传输层按需解析 |

`AUTH_FAILED` / 缺凭据文案统一包含三个来源与可执行修复命令：
`export KEEL_GITHUB_TOKEN="$(gh auth token --hostname <host>)"` 或
`gh auth login --hostname <host>`，且不打印任何 token 片段。

### 4. Validation & Error Matrix

| 条件 | 结果 |
|---|---|
| env 有非空 token | 直接使用，不调用 `gh` |
| env 全空 / 全空白 + `gh` 已登录 | 用 gh 输出（trim 后） |
| `gh` 不存在 / 未登录 / 超时 / 空白输出 | `undefined`；入口映射 `AUTH_FAILED` |
| 入口需要 GitHub 且无 token | `AUTH_FAILED`（非 0 退出），先于 ingest / 驱动 |
| `ci !== 'real'` | 不解析 token，不调用 `gh` |
| 注入 `opts.github`（run-issue ingest 侧） | 跳过 ingest 侧预检 |
| 非 http(s) / 非 GitHub host / 解析失败 | git 传输不注入认证 env，不调用 resolver |
| `gh` 输出或 git stderr 含 token | `redactSecrets` 替换为 `***` 后才进 detail / 日志 |

### 5. Tests Required

- `src/fact/github-auth.test.ts`：env 优先级、空白 env 回落 gh、host 透传、
  gh 成功 / 空白 / ENOENT / 抛错。**全部注入 `runGh`，不得调用真实 gh。**
- `src/fact/github-provider.test.ts`：按 host 解析与缓存、显式 token 不触发 resolver、
  无 token 的 `AUTH_FAILED` 文案。
- `src/fact/git-workspace.test.ts`：无 env + 注入 resolver 时仍生成 `GIT_CONFIG_*`；
  gh 来源 token 被 `secrets()` 覆盖（错误 detail 不含明文 / base64）。
- CLI：`run-issue` / `poller` / `run-task` 各覆盖「resolver 无值 → 零写入失败」与
  「resolver 有值 → 进入」。**任何测试不得依赖开发机 `~/.config/gh` 的登录态。**

### 6. Wrong vs Correct

**Wrong**：每个入口自己读 env / 自己拼 `gh` 调用

```ts
if (process.env.KEEL_GITHUB_TOKEN === undefined) return err('AUTH_FAILED')
```

**Correct**：统一走 `resolveGitHubToken`，入口只决定 host

```ts
const token = await requireGitHubToken(host, tokenResolver)
if (!token.ok) return token
```
