# GHES host 支持 — 技术设计

> 父任务：`11-03-enterprise-deployment`。需求见 `prd.md`。

## 1. 现状

`src/fact/github-provider.ts` 是一个适配器：

- `API_ROOT` 是模块常量；
- `ownerRepo(remoteUrl)` 用一条只认 `github.com` 的正则；
- `parseIssueUrl(url)` 同理；
- `GitHubProvider.request(path)` 直接拼 `this.root + path`，实例只知道一个 root。

调用方：

| 调用方 | 用到什么 |
|---|---|
| `run-task.ts` | `new GitHubProvider()`（CI gateway） |
| `ingest-issue.ts` | `parseIssueUrl`、`ownerRepo`、`getIssue` |
| `register-repo.ts` | 只用 `normalizeRemoteUrl`，不解析 host |
| 验收测试 | `ownerRepo` 做 cleanup；`new GitHubProvider({ apiRoot: baseUrl })` |

## 2. 设计决策

### 2.1 一个解析函数，三个出口

新增纯函数（同文件导出）：

```ts
export interface ParsedRemote {
  readonly host: string        // 小写，不含端口，例如 github.example.com
  readonly owner: string
  readonly repo: string        // 已剥离 .git
  readonly remoteUrl: string   // 归一化后的 https URL（供事件/注册使用）
}

export function parseRemoteUrl(remoteUrl: string): Result<ParsedRemote>
export function isGitHubHost(host: string): boolean
```

`isGitHubHost`：`github.com` 或 `github.*`（且不是 `github.com.*`）。
不接受任意 host —— provider 是 GitHub 专用，`gitlab.com` 之类被误当 GHES
只会把请求打到错误的服务。非 `github.*` 的企业域名不在本任务范围。

- `ownerRepo()` 改为 `parseRemoteUrl(...).map(r => `${r.owner}/${r.repo}`)`，
  **签名不变**，所有现有调用点零改动。
- `parseIssueUrl()` 用同一套 host/owner/repo 规则，只多匹配 `/issues/<n>`。
- `apiRootForHost(host)` 独立导出，供 §3 的 git 传输认证复用 host 解析。

解析实现按语法分支，不写一条巨型正则：

1. **SCP-like**：`^[^@]+@([^:]+):(.+)$` → host = group1，path = group2。
2. **URL**：`new URL(remoteUrl)`（接受 `http:` / `https:` / `ssh:`）。
   host = `url.hostname`，path = `url.pathname`。
3. 其余 → `WORKSPACE_ERROR`。

path 归一：去前导 `/`、去尾随 `/`、剥离一次 `.git`、`split('/')` 必须恰好两段。

**命名校验**：owner 匹配 `^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$`；
repo 匹配 `^[A-Za-z0-9._-]+$` 且不等于 `.` / `..`。
比 GitHub 实际规则略严是刻意的：enterprise host 上出现 `..` 只会是攻击或错误输入。

### 2.2 API root 的优先级

```ts
function apiRootForHost(host: string): string {
  return host.toLowerCase() === 'github.com'
    ? 'https://api.github.com'
    : `https://${host}/api/v3`
}
```

请求时按 host 解析，优先级：

```
构造参数 opts.apiRoot (测试显式注入)
  > 环境变量 KEEL_GITHUB_API_ROOT
  > apiRootForHost(host)
```

- 环境变量在构造时读取一次（与 token 一致），进程生命周期内不变。
- **空白或非 http(s) 的 `KEEL_GITHUB_API_ROOT` 不是「未设置」**：
  每次请求返回 `WORKSPACE_ERROR`，绝不静默回退到公网。
  理由：企业部署里把内网 remote 静默打到 `api.github.com` 是数据外流，不是便利。
- `opts.apiRoot` 仍是最强覆盖，现有 stub server 测试（host = `127.0.0.1`）行为不变。

### 2.3 Provider 内部

```ts
private rootFor(host: string): Result<string>   // 解析上表优先级
private request(host: string, path: string)      // 替代 request(path)
```

所有公开方法都持有 `remoteUrl`，先 `parseRemoteUrl` 再请求：

- `createPullRequest` / `waitForCi` / `getIssue`：已有 `input.remoteUrl`。
- `findExistingPr(slug, headBranch)` 增加 `host` 参数。
- `combinedStatus(slug, sha)` 增加 `host` 参数。

同一个 provider 实例因此可以跨多个 host 工作 —— 这是 poller（§2）扫多仓库的前提。

## 3. 兼容性

| 场景 | 现状 | 改动后 |
|---|---|---|
| `https://github.com/o/r.git` | `/o/r` | 同上 |
| `git@github.com:o/r.git` | `/o/r` | 同上 |
| github.com API | `https://api.github.com` | 同上（`apiRootForHost` 分支） |
| `new GitHubProvider({ apiRoot })` | 用传入值 | 同上（最高优先级） |
| `file:///tmp/repo` | 解析失败 | 仍解析失败 |
| GHES remote | 解析失败 | 成功，host 保留 |

## 4. 测试计划

单测（`src/fact/github-provider.test.ts`）：

- `parseRemoteUrl` / `ownerRepo` 表驱动：
  `https://github.com/o/r`、`https://github.com/o/r.git`、`git@github.com:o/r.git`、
  `https://github.example.com/o/r.git`、`http://ghe.corp.example/o/r`、
  `ssh://git@github.example.com/o/r.git`、尾斜杠、`..`、单段路径、`owner/repo/extra`。
- `parseIssueUrl`：github.com / GHES / 尾斜杠 / 非 issues URL / `pull/1`。
- `apiRootForHost`：`github.com`、`GitHub.com`（大小写）、GHES host。
- Provider stub server：
  - 不传 `apiRoot`、remote 为 GHES host 时，请求打到 `https://<host>/api/v3`（用 fetch 注入断言）。
  - `KEEL_GITHUB_API_ROOT` 覆盖 host 推导。
  - 空白 `KEEL_GITHUB_API_ROOT` → 请求返回错误且 fetch 未被调用。

## 5. 回滚

纯函数与内部请求路径改造，无 schema / 数据迁移。回滚 = revert 单个 commit。
