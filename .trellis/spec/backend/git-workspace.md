# Git 工作区纪律

> 记录**实际**做法。来源：`08-26-v01-closeout` 任务的验收排障
> （`pnpm run check` 在开了 commit 签名的操作者机器上超时）；
> 代码在 `src/fact/git-workspace.ts`。

---

## Agent 的 git 提交：行为相关配置一律用 `-c` 钉死，不继承全局

`commitAll` 的实际写法：

```ts
// src/fact/git-workspace.ts
await exec('git', [
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
await exec('git', ['-C', wt, '-c', 'user.email=keel@localhost', '-c', 'user.name=Keel', 'commit', '-m', message])
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

`KEEL_HOME` 在进程启动时解析成绝对路径（默认 `<cwd>/.keel`），
之后所有路径都基于它 —— 不让 cwd 中途变化改变已绑定项目的位置。

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

`ensureWorktree` 幂等：worktree 存在 → `created: false`，分支不动。
`CreateBranch` 事件因此分两种情况：

- 首次：`base_ref` / `base_sha` / `fetched_at` 取自本次 `prepareProject`，`reused: false`；
- 复用：读该 task 最近一条 `CreateBranch` 事件，**沿用旧 `base_sha`**，`reused: true` ——
  本次 prepare 可能已经 fetch 到更新的 commit，但那条分支没有跟着移动，
  证据必须描述分支真正的起点。老 task 没有历史事件时写 `base_sha: null`，不编造。

## 并发与锁

同一 repo 上的 `prepare` / `worktree` / `remove` 共用一把锁
`<KEEL_HOME>/locks/repo-<repoId>.lock`（原子 `mkdir`，30s 超时，50ms 轮询；
`op` 只出现在错误与 `owner.json` 里，不参与锁路径）。
锁目录里的 `owner.json` 只用于诊断，**不自动破锁** ——
在慢 fetch 上自动删锁会让两个进程同时持锁，比等待更糟。

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
