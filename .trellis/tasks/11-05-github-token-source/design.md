# 设计：GitHub token 来源与启动期校验

> 对应 PRD `prd.md`；issue #73 第 3 项。

## 不变量

1. token 不进 argv、日志、事件、错误 `detail`、git config 文件。
2. 来源优先级固定：`KEEL_GITHUB_TOKEN` → `GITHUB_TOKEN` → `gh auth token --hostname <host>`。
3. 空白值等同未设置（`KEEL_GITHUB_TOKEN=''` 不得遮蔽 `gh` 登录态）。
4. 需要 GitHub 的入口在**任何 ingest / 驱动写入前**解析 token；缺失即非 0 退出。
5. 纯本地命令不因缺 token 失败。

## 解析器（单一事实源）

`src/fact/github-auth.ts` 新增：

```ts
export interface TokenResolveDeps {
  readonly env?: NodeJS.ProcessEnv
  /** 测试注入；缺省真的调用 `gh` */
  readonly runGh?: (host: string) => Promise<string | undefined>
}

/** host 必须是 hostname（不含端口）；缺省 github.com */
export async function resolveGitHubToken(
  host?: string,
  deps?: TokenResolveDeps,
): Promise<string | undefined>
```

语义：

- 先读 env：`KEEL_GITHUB_TOKEN`、`GITHUB_TOKEN` 取第一个 `trim() !== ''` 的值。
- 都没有才调用 `gh auth token --hostname <host>`（`execFile`，5s 超时，无 shell）。
- `gh` 不存在、未登录、超时、输出空白 → 返回 `undefined`，**不抛异常、不返回 stderr**
  （错误文本里可能含凭据，解析器不把它带出去）。
- 纯读函数，不做进程级缓存：缓存放在调用方实例上，避免测试污染与 token 轮换歧义。

## 消费方接线

### GitHubProvider（API）

- 新增构造参数 `tokenResolver?: (host: string) => Promise<string | undefined>`，缺省 `resolveGitHubToken`。
- 显式 `opts.token` 仍拥有最高优先级，且**给了就不再走 gh**（测试用它强制“无凭据”）。
- `request(host)` 内按需解析并缓存到 `Map<host, string>`；env 有值时不调用 gh。
- 无 token 的 `AUTH_FAILED` 文案改为三个来源 + `gh auth login`，不打印 host 之外的敏感信息。

### GitWorkspace（git 传输）

- 构造参数新增 `tokenResolver?`，缺省同上。
- `execGit(..., { auth: remoteUrl })` 先解析该 remote 的 host 对应 token，再交给
  现有 `authEnvFor`；`authEnvFor` / `GIT_CONFIG_*` 注入方式不变。
- 解析结果按 host 缓存在实例上，同时加入 `secrets()` 的脱敏集合 ——
  否则 gh 来源的 token 不会出现在 git 错误脱敏里。
- 无 token / 非 http(s) / 解析失败 → 与现在一致，不加认证 env。

### 入口预检

| 入口 | host 来源 | 行为 |
|---|---|---|
| `run-issue` | `parseIssueUrl(issueUrl)` 的 hostname | 解析失败/缺 token → `AUTH_FAILED`，**先于 ingest**；注入 `opts.github` 时跳过 |
| `poller` | `loadGithubRepos()` 后按 `parseRemoteUrl` 取唯一 hostname 集合 | 任一 host 缺 token → 非 0 退出，**先于第一轮扫描**；保留每轮 live 读 repo 列表的行为 |
| `run-task --ci real` | task 对应 repo 的 `remote_url` | `resolveCiGateway` 改 async；`task-workspace.ts` 新增只读 `loadTaskRemoteUrl(taskId)`，gateway 创建仍在 `loadTaskWorkspace` 之前（不做无谓的 clone/fetch） |
| `register-repo` | — | 不做启动期预检（注册本身是本地操作）；clone/fetch 由传输层按需解析 |

帮助文案统一改为「需要 GitHub 凭据（KEEL_GITHUB_TOKEN / GITHUB_TOKEN / gh auth login）」。

## 测试注入面

`gh` 是进程外依赖，**任何测试都不得依赖开发机的登录态**：

- `RunIssueOptions` / `RunTaskOptions` 增加 `tokenResolver?: (host: string) => Promise<string | undefined>`
  （只传给 `resolveCiGateway` / 入口预检）。
- `PollerMainDeps` 增加同名注入点。
- 现有「`--ci real` 缺 token → AUTH_FAILED 且零写入」用例显式传 `tokenResolver: async () => undefined`；
  新增成功用例传返回固定 token 的 resolver，断言不触碰真实 `gh`。
- provider / git-workspace 的 resolver 注入见上一节。

## 测试策略

- `github-auth.test.ts`：env 优先级、空白 env 落到 gh、gh 成功/失败/ENOENT、host 透传。
  全部注入 `runGh` 或显式 env，**绝不依赖开发机的 `gh` 登录态**。
- `github-provider.test.ts`：注入 resolver，验证按 host 解析、结果缓存、显式 token 不触发 gh、
  无 token 的 `AUTH_FAILED` 文案。
- `git-workspace.test.ts`：无 env + 注入 resolver 时仍生成 `GIT_CONFIG_*`；
  gh 来源的 token 进入 `secrets()` 脱敏集合。
- CLI：`run-issue` / `poller` / `run-task` 各一条「无 env + resolver 无值 → 零写入失败」，
  以及「resolver 有值 → 正常进入」的用例（用注入点，不跑真 gh）。

## 兼容 / 回滚

- 默认行为对已配置 `KEEL_GITHUB_TOKEN` 的用户完全不变；gh 只在 env 全空时尝试。
- 回滚：删掉解析器的 gh 分支与三个入口预检即可，表结构 / 事件 / argv 均未改。
