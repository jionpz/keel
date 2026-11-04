# Git 工作区纪律

> 记录**实际**做法。来源：`08-26-v01-closeout` 任务的验收排障
> （`pnpm run check` 在开了 commit 签名的操作者机器上超时）；
> 代码在 `src/fact/git-workspace.ts`。

---

## Agent 的 git 提交：行为相关配置一律用 `-c` 钉死，不继承全局

`commitAll` 的实际写法：

```ts
// src/fact/git-workspace.ts
await this.execGit([
  '-C', wt,
  '-c', 'user.email=keel@localhost',
  '-c', 'user.name=Keel',
  '-c', 'commit.gpgsign=false',
  'commit', '-m', message,
])
```

**为什么 `commit.gpgsign=false` 不是可选项**，两个真实后果：

1. **身份伪造**：提交是机器署名（`Keel <keel@localhost>`），
   继承操作者的 `commit.gpgsign=true` 会用**人的密钥**给 Agent 产物签名 ——
   签名声称「此人做了这个提交」，而这不是事实。
2. **无人值守挂起**：签名程序可能交互提示（passphrase、touch key）或变慢。
   实测：操作者全局配置带 `gpg.ssh.program` 时，每个提交 5s → 24s → 超时，
   `pnpm run check` 从 2.9s 涨到 32s 并最终 `Hook timed out`。
   在无人干预的编排循环里，一次交互提示等同于永久挂起。

推广规则：**新增任何 git 子进程调用时，凡是会改变行为的配置
（身份、签名、hook、编辑器）都要显式钉死，不假设操作者的全局配置是中性的。**

## 测试夹具同样要关签名

每个用 `git init` 铺夹具的测试，seed 提交前都要：

```ts
execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: ws })
```

已覆盖的夹具：`git-workspace` / `effects` / `orchestrator-workspace` /
`ci-wiring` / `v01-criterion` 五处。新夹具照抄。

> 注意与凭据的边界：跑**验收**时不要用 `GIT_CONFIG_GLOBAL=/dev/null` 一刀切 ——
> 那会连 `gh` 的 credential helper 一起屏蔽，push 失去鉴权
> （见 `quality-guidelines.md` §验收测试的凭据）。签名干扰已在代码里根治。

---

## Wrong vs Correct

### Wrong

```ts
// 只钉身份不钉签名 —— 提交行为仍受操作者全局配置摆布
await this.execGit(['-C', wt, '-c', 'user.email=keel@localhost', '-c', 'user.name=Keel', 'commit', '-m', message])
```

### Correct

身份 + 签名都钉死（见上）。

---

## 测试锚点（反例已验证）

`src/fact/git-workspace.test.ts` ·「不继承全局签名配置」：
把 `GIT_CONFIG_GLOBAL` 指向「强制签名 + 必然失败的签名程序」的配置，
断言 `commitAll` 仍成功且 `git log --format=%G?` 为 `N`（无签名）。

反例验证记录：去掉 `-c commit.gpgsign=false` 后该测试**确实变红**，恢复后通过 ——
遵循「未经反例验证的检查，等同于没有检查」（`error-handling.md` §防假绿）。

---

# 项目绑定与开工基线（10-27-local-project-binding）

> 代码：`src/fact/git-workspace.ts` / `src/fact/project-root.ts` /
> `src/fact/file-lock.ts` / `src/fact/workspace-error.ts`；
> 设计见 `.trellis/tasks/10-27-local-project-binding/design.md`。

## 两种绑定模式

| 模式 | 何时 | 裸仓库（object store） | `gitDir` |
|---|---|---|---|
| `managed` | `repo.local_path IS NULL` | `<KEEL_HOME>/repos/<repo_id>.git`，Keel 克隆并维护 | 那个裸仓库 |
| `attached` | `repo.local_path = '<绝对路径>'` | 用户自己的 worktree 充当对象库 | 用户那个目录 |

两种模式下 worktree 都在 `<KEEL_HOME>/worktrees/<task_id>/`，
分支都是 `ai/task-<前 8 位>`。attached 模式**只读用户工作树**：
只 `fetch` / `worktree add`，不 commit、不 checkout、不写文件（测试断言前后字节一致）。

`KEEL_HOME` 在进程启动时解析成绝对路径：
显式设置时按 cwd 解析；未设置时从 cwd **向上**找最近的已有 `.keel` 目录，
否则找最近的 `.git` **目录**并在同层创建 `.keel`，都没有才回退 `<cwd>/.keel`。
`.git` 只认目录 —— worktree / submodule 的 `.git` 是文件，不能当项目根。
这样项目树内任意子目录启动都命中同一个根；项目树外启动仍需显式 `KEEL_HOME`。
默认 blob 根跟随 `KEEL_HOME`（`<KEEL_HOME>/blob`），显式 `KEEL_BLOB_DIR` 优先。

## 开工前同步：基线是 SHA，不是 ref 名

```ts
const prepared = await git.prepareProject(binding, remoteUrl, baseBranch)
// prepared.baseRef  = 'refs/remotes/origin/main'
// prepared.baseSha  = '<40 hex>'   ← worktree 从这里长出来
// prepared.fetchedAt = ISO 时间
```

- `fetch` 用**显式 refspec** `+refs/heads/<base>:refs/remotes/origin/<base>`
  加 `--prune`，不依赖用户仓库 `remote.origin.fetch` 的配置 ——
  用户的配置可能只抓单个分支、或根本没配。
- `worktree add` 锚定 `baseSha` 而不是 `origin/<base>`：并发 fetch 会移动 ref，
  按 ref 建会让两个 Task 从不同 commit 长出来，而证据里写的是同一个名字。
  测试「prepare 之后 ref 前进，worktree 仍锚定原 commit」钉住这一点。
- 裸仓库先 `rev-parse --is-bare-repository` 验证，再 clone 到
  `.tmp-<repoId>-<pid>` 后 `rename` —— 「存在就当可用」会把半成品当成缓存。

## 重放语义

`ensureWorktree` 幂等，但**两个「新建」必须分开**：

- `created`：本次是否新建 worktree；
- `branchCreated`：本次是否新建分支。

worktree 被清理后重放时 `created=true` / `branchCreated=false`：
worktree 是新的，分支不是，起点仍是当初那次 prepare 的 commit。

`CreateBranch` 事件因此分两种情况：

- `branchCreated=true`：`base_ref` / `base_sha` / `fetched_at` 取自本次 `prepareProject`，
  `reused: false`；
- `branchCreated=false`：读该 task 最近一条 `CreateBranch` 事件，**沿用旧 `base_sha`**，
  `reused: true` —— 本次 prepare 可能已经 fetch 到更新的 commit，但那条分支没有
  跟着移动，证据必须描述分支真正的起点。老 task 没有历史事件时写 `base_sha: null`，
  不编造。

路径已存在时先 `inspectWorktree`：`.git` 必须存在，`rev-parse --abbrev-ref HEAD`
必须等于期望分支。不满足就 fail closed（错误带 expected/actual），**不删目录**
（可能含未提交内容）。路径被外部删除但 git 元数据还在时，`worktree add` 失败后
`worktree prune` 再重试一次 —— 否则 task 会永久卡在 `worktree_failed`。

## 并发与锁

同一 repo 上的 `prepare` / `worktree` / `remove` 共用一把锁
`<KEEL_HOME>/locks/repo-<repoId>.lock`（原子 `mkdir`，30s 超时，50ms 轮询；
`op` 只出现在错误与 `owner.json` 里，不参与锁路径）。
锁目录里的 `owner.json` 只用于诊断，**不自动破锁** ——
在慢 fetch 上自动删锁会让两个进程同时持锁，比等待更糟。

恢复入口是人显式执行的 `keel unlock <repoId> [--force]`：
无 `--force` 只报告持有者并拒绝，`--force` 才删除锁目录。
`lock_timeout` 错误带 `hint` 字段指向这条命令；`GitWorkspace` 的锁固定传
`hint="pnpm keel unlock <repoId> --force"`。

## 错误契约

失败一律 `WORKSPACE_ERROR`，`detail` 以 `[code]` 开头、字段固定（`src/fact/workspace-error.ts`）：

```
[origin_mismatch] expected="github.com/a/b" actual="github.com/a/c"
```

code 全集：`local_path_missing` / `not_a_git_worktree` / `origin_mismatch` /
`local_path_taken` / `git_dir_invalid` / `fetch_failed` / `base_missing` /
`lock_timeout` / `lock_failed` / `worktree_failed`。

`base_missing` 是 `fetch_failed` 的一个特例：git 对不存在的 ref 报的是
`couldn't find remote ref`，按 stderr 归类，不把「分支名写错」混进「网络故障」。

`remove` 只经 `Result` 报错、不抛异常：调用方（`cleanWorkspace`）据此把失败
写成 `SideEffectIntent`，而不是让已经成立的终态回滚。`git worktree remove`
失败时退回直接删目录；目录真的删掉才算成功，`prune` 只是尽力而为。

---

# git https 传输认证（11-03-git-transport-auth）

> 代码：`src/fact/github-auth.ts`（凭据纯逻辑）、`src/fact/git-workspace.ts`（注入点）；
> host 解析复用 `src/fact/github-remote.ts`，不写第二套正则。

## Scenario: 私有 https remote 的认证注入

### 1. Scope / Trigger

- 触发：clone / fetch / push 访问私有 https remote 需要 `KEEL_GITHUB_TOKEN` / `GITHUB_TOKEN`。
- 影响面：三条网络调用的子进程环境；`git-workspace.ts` 的全部错误出口。
- 风险：token 进 argv（同机 `ps` 可见）或进错误 detail（落进事件表）。

### 2. Signatures

```ts
export function readTokenFromEnv(): string | undefined   // KEEL_GITHUB_TOKEN 优先
export function authEnvFor(
  remoteUrl: string,
  token: string | undefined,
  baseEnv?: NodeJS.ProcessEnv,   // 只用于读既有 GIT_CONFIG_COUNT；测试注入
): Record<string, string>
export function gitAuthSecrets(token: string | undefined): readonly string[]
export function redactSecrets(text: string, secrets: readonly string[]): string

export type GitExec = (
  file: string,
  args: readonly string[],
  opts?: { env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>

class GitWorkspace { constructor(opts?: { root?: string; exec?: GitExec }) }
```

### 3. Contracts

`authEnvFor` 成功时返回三件套，**只对本次子进程生效，不写任何 config 文件**：

```ts
{
  GIT_CONFIG_COUNT: '<n+1>',
  [`GIT_CONFIG_KEY_<n>`]: 'http.<scheme>://<authority>/.extraheader',
  [`GIT_CONFIG_VALUE_<n>`]: 'AUTHORIZATION: basic <base64("oauth2:"+token)>',
}
```

- **authority 来自 `new URL(remoteUrl).host`**，不是 `parseRemoteUrl().host`：
  后者不含端口。git 对 `http.<url>.*` 的匹配规则是「省略端口按 scheme 默认端口处理」
  （`man git-config`），所以 `https://host:8443/...` 必须写成 `https://host:8443/`，
  否则认证静默失效。`URL.host` 同时省掉 443/80，与 git 语义一致。
- **合并**：已有 `GIT_CONFIG_COUNT` 时**追加**，不覆盖操作者配置；非数字值按 0。
- **注入点**：只有 `ensureGitDir`（clone）、`syncBase`（fetch）、`push` 传 `{ auth }`。
  worktree / commit / status / remove / rev-parse 是本地操作，**不传 env**（连空 env 都不传）。

### 4. Validation & Error Matrix

| 条件 | 结果 |
|---|---|
| 无 token / token 空白 | `{}`，调用形态与未接入认证前完全一致 |
| `ssh://`、SCP-like(`git@host:o/r`) | `{}` —— 走部署方 ssh key，代码不碰凭据 |
| `file://`、解析失败 | `{}` —— 让 git 自己报错，认证层不吞解析错误 |
| host 不在 `github.com` / `github.*` | `{}` —— token 不发往非 GitHub 服务 |
| http(s) + 有效 token | 返回三件套；key 带非默认端口，省默认端口 |
| git 输出含明文 token 或其 base64 | `redactSecrets` 替换为 `***` 后才进 `detail` |

### 5. Good / Base / Bad Cases

- **Good**：`https://github.example.com:8443/acme/widget.git`
  → `http.https://github.example.com:8443/.extraheader`
- **Base**：`https://github.com/acme/widget.git`
  → `http.https://github.com/.extraheader`（与是否设 token 无关，只有 set 时才注入）
- **Bad**：`git -c http.https://github.com/.extraheader=... clone ...` —— 值进 argv

### 6. Tests Required

`src/fact/github-auth.test.ts`（15 用例）：

- https / http / GHES host / 非默认端口 / 默认端口被规范化掉
- 无 token、空白 token、ssh、SCP-like、file://、非 GitHub host → `{}`
- 既有 `GIT_CONFIG_COUNT=2` → 追加为第 3 组；非数字按 0
- `redactSecrets`：明文 token、base64、`Bearer <token>`、空 secret 不破坏文本

`src/fact/git-workspace.test.ts`（33 用例）：

- 注入路径用 `exec` 注入捕获真实 argv/env：header 在 env、token 不在 argv
- 无 token 时 https remote 的 `opts` 为 `undefined`（不是空 env）
- `commitAll` 的 env 不含 `GIT_CONFIG_*`，且 `-c user.email/user.name/commit.gpgsign=false` 原样保留
- fetch 失败时 stderr 里的 token 也被脱敏（三个出口都要有反例验证）

### 7. Wrong vs Correct

**Wrong**：用 `-c` 传 header，或把 token 塞进 URL

```ts
await exec('git', ['clone', `https://oauth2:${token}@${host}/o/r.git`, dest])
// argv / remote URL / 错误消息里都有凭据
```

**Correct**：环境变量只作用于本次子进程

```ts
const auth = authEnvFor(remoteUrl, readTokenFromEnv())
await this.exec('git', args, { env: { ...process.env, ...auth } })
```

## 运行前提与已知边界

- `GIT_CONFIG_COUNT` 机制需要 **git ≥ 2.31**（本机 2.39.5 已验证注入被 git 采纳）。
- 认证失败仍映射 `WORKSPACE_ERROR`，不新增 ErrorKind。
- 已知边界：`push` 失败 detail 会原样带 `remoteUrl`。若注册时 URL 自带 userinfo
  （`https://u:p@host/...`），它会出现在 detail 里；环境 token 不受影响。
  这是接入认证前就有的行为，改动前先确认是否需要脱敏 URL userinfo。
- REST 侧的非默认端口不在本机制内：`apiRootForHost` 仍按 host 推导，
  GHES 在非 443 端口时要用 `KEEL_GITHUB_API_ROOT` 显式覆盖（见 `github-provider.md`）。
