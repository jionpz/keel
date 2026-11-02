# git 传输认证 — 技术设计

## 1. 关键决策

### 1.1 用环境变量注入，而不是 `-c` 参数

issue 建议 `-c http.<host>.extraheader=...`。但 `-c` 的值会出现在：

- 进程 argv（同机任何用户 `ps` 可见）；
- `execFile` 抛出的错误消息（本项目大量 `msg(e)` 直出 detail）。

改用 git 的等价机制，只对子进程生效：

```ts
env.GIT_CONFIG_COUNT = String(n)
env[`GIT_CONFIG_KEY_${i}`] = `http.https://github.example.com/.extraheader`
env[`GIT_CONFIG_VALUE_${i}`] = `AUTHORIZATION: basic <base64>`
```

效果与 `-c` 相同（单次调用生效、不写任何 config 文件），但 token 不进 argv。
这满足 issue 的目的，且严格优于它的字面写法。已在 design 中记录偏离理由。

### 1.2 新模块 `src/fact/github-auth.ts`

只放与「GitHub 凭据怎么用」有关的纯逻辑，供 provider 与 workspace 共用：

```ts
export function readTokenFromEnv(): string | undefined          // 从 provider 迁来
export function authEnvFor(remoteUrl: string, token?: string): Record<string, string>
export function redactSecrets(text: string, secrets: readonly string[]): string
```

`github-provider.ts` 改为从这里 import 并 **re-export** `readTokenFromEnv`，
现有调用点（`run-task.ts`、验收测试）零改动。

`authEnvFor`：

1. `token === undefined || token.trim() === ''` → `{}`。
2. `parseRemoteUrl(remoteUrl)`（来自 GHES 子任务）；失败 → `{}`（让 git 自己报错，
   不在认证层吞掉解析错误）。
3. 只处理 `http:` / `https:`。SCP-like 与 `ssh:` → `{}`。
4. 计算：
   ```
   key   = `http.${scheme}://${host}/.extraheader`
   value = `AUTHORIZATION: basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`
   ```
5. **合并**既有 `GIT_CONFIG_COUNT`：从当前值开始追加，保留用户配置；
   非数字的既有值视为 0（不静默继承脏值，但也不报错 —— git 自己会拒绝非法值）。

### 1.3 错误清洗

`exec` 失败时统一走：

```ts
const reason = redactSecrets(msg(e), this.secrets())
```

`secrets()` 返回 `[token, base64('oauth2:'+token)]`（去重、非空）。
替换为 `***`。`git-workspace.ts` 里所有 `msg(e)` 出口（clone / fetch / push /
worktree / commit）都要过这一层，避免未来新增调用点漏掉。

> 注：`commitAll` 的错误不含凭据，但统一走同一函数没有坏处。

### 1.4 注入点

| 方法 | 现状 | 改动 |
|---|---|---|
| `ensureGitDir` → `git clone` | 裸 exec | `execGit(args, { auth: remoteUrl })` |
| `syncBase` → `git fetch` | 裸 exec | 同上（gitDir 已有 origin，用传入的 remoteUrl 解析 host） |
| `push` | 裸 exec | 同上 |
| `ensureWorktree` / `commitAll` / `status` | 本地操作 | 不注入（无网络） |

`syncBase` 当前签名只有 `(gitDir, baseBranch)`，需要补 `remoteUrl`：
`prepareProject` 已持有它，直接透传。

### 1.5 测试注入

`GitWorkspaceOptions` 增加：

```ts
readonly exec?: (file: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>
```

缺省仍用 `promisify(execFile)`。这样单测可以捕获实际传给 git 的 env，
断言 header 存在且 argv 里没有 token —— 不依赖起一个 https git server。

## 2. 测试计划

纯函数：

- `authEnvFor`：https + token → 1 组 `GIT_CONFIG_*`；ssh → 空；无 token → 空；
  既有 `GIT_CONFIG_COUNT=2` → 追加为第 3 组。
- `redactSecrets`：token、base64、`Bearer x` 都被替换；无关文本不变。

注入路径（用 `exec` 注入）：

- `ensureGitDir` / `syncBase` / `push` 的 env 含正确 header，argv 不含 token。
- `commitAll` 的 env 不含 `GIT_CONFIG_*`（本地操作不注入）。

回归：

- 现有 `git-workspace.test.ts` 全部保持真实 git 跑通（file:// origin 不触发注入）。

## 3. 兼容性与回滚

- 无 token：`authEnvFor` 返回空对象，env 与现状一致。
- 有 token 但 remote 是 file:// / ssh：同样返回空对象。
- 无数据库变更。回滚 = revert commit。
