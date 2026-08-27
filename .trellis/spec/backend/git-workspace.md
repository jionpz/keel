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
