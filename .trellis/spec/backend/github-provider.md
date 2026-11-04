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
