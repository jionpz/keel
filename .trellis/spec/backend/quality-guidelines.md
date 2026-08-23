# 质量约定

> 记录**实际**做法。来源:`08-22-repo-skeleton`、`08-23-split-acceptance-tests`、
> `08-23-persistence-artifact-store` 任务;配置在 `biome.json`、`tsconfig.json`、`vitest*.ts`。

---

## 一条命令:质量门槛是 `pnpm run check`

CI 与本地跑**完全相同**的命令,不存在「本地过了 CI 挂」的配置差异:

```
lint → typecheck → boundaries → check:generated → check:transitions → check:purity → test
```

每一段守护的东西见 `.trellis/spec/backend/directory-structure.md`(边界)与
根 `README.md` §四条被机械化的架构约束。**不要绕过其中任何一段**;
要放宽约束走 ADR,不要注释掉配置。

---

## TypeScript:全严格开关是基线

`tsconfig.json` 开启的不只是 `strict`,还包括:

| 开关 | 防的实际问题 |
|---|---|
| `noUncheckedIndexedAccess` | 数组/记录按下标访问得到 `T \| undefined`,强制处理越界 |
| `exactOptionalPropertyTypes` | 不能用显式 `undefined` 冒充「字段缺省」 |
| `verbatimModuleSyntax` | 类型 import 必须写 `import type`(配合 ESM `.js` 后缀,见 directory-structure.md) |
| `noImplicitOverride` / `noFallthroughCasesInSwitch` / `noImplicitReturns` | 常规防呆 |

新代码不允许降级任何开关;局部 `@ts-expect-error` 必须带一行中文理由。

## 格式与 Lint:Biome

- 格式化由 Biome 负责(`pnpm run lint:fix`),**不要手调空格换行**
- 单引号、无分号(除必要)、尾逗号 `all`
- import 自动整理(`assist.actions.source.organizeImports`)
- `src/generated` 整体跳过 —— 对生成代码做风格检查没有意义

---

## 测试分层:回归 / 验收 / 纯函数三层

判断标准只有一条:**断言是否依赖模型「说了什么」。**

| 层 | 位置 | 命令 | 判据 |
|---|---|---|---|
| 回归 | 各模块旁 `*.test.ts` | 默认 `check` 内 | 只依赖工具行为,结果确定 |
| 验收 | `src/acceptance/*.acceptance.test.ts` | `pnpm run test:acceptance` 显式跑 | 依赖模型输出内容,天然有波动 |
| e2e | `src/e2e/*.test.ts` | 默认 `check` 内 | 编排器 + 真实 worktree,不碰模型 |

**flaky 测试不得留在默认 `check` 里。** 理由见 `src/acceptance/README.md`:
本项目核心资产是「让违规成为 CI 失败」这套机制,check 因非代码原因变红,
人就会开始忽略它 —— 检查一旦不可信就等于没有检查。

禁止为了让验收测试稳定而放宽 schema 或降低断言强度;
也禁止「环境不可用则 skip」—— 那是假绿,连不上就让测试失败
(见 database-guidelines.md §不做「数据库不可用则跳过」)。

### 文件级约定

- 测试文件与被测文件**同目录**,命名 `*.test.ts`(验收测试例外,集中在 `src/acceptance/`)
- 数据库测试串行:`fileParallelism: false`(多文件共享同一个库,beforeEach TRUNCATE 会互相清数据)
- 全局装置在 `vitest.globalSetup.ts`:迁移执行一次,不每个文件重复

### 不 mock 外部系统

`adapters.test.ts` 的分层注释是这个项目的标准姿势:

1. **纯函数**(解析、tier、argv)→ 用真实抓到的样本 fixture,不起进程
2. **契约拒绝**(schema 违规、能力未声明)→ 不起进程
3. **真实集成** → 真调 omp + deepseek,慢且花钱,**但不做 mock**

理由:mock 一个 harness 验证的是「我以为它会怎样」,不是「它实际怎样」。
本项目已经为「未经反例验证的检查」付出过代价(见 error-handling.md §防假绿)。

### 不变量测试 = 主动违规尝试

`src/fact/invariants.test.ts` 的每个用例都是一次**期望被拒绝的写入**。
测试失败时改授权,不改测试(见 database-guidelines.md)。

### 反例验证检查脚本本身

新增检查脚本(C1–C4 这类)后,必须**逐条制造一次违规**,确认它真的会红。
一个什么都不检查的 CI 也是绿的。

---

## Required Patterns(必须遵守)

| 模式 | 出处 |
|---|---|
| 可预期失败返回 `Result<T>`,异常只留给编程错误 | `error-handling.md`;`src/contracts/errors.ts` |
| 生产写入以角色身份进行(`asRole`),永不用 `asOwner` 写生产数据 | `database-guidelines.md` |
| 相对 import 带 `.js` 后缀 + `import type` | `directory-structure.md` |
| 副作用只能作为转移函数返回值中的描述 | `directory-structure.md` §transition 纪律 |
| 检查脚本失败输出必须含位置、原因引用、修法 | `error-handling.md` §检查脚本的失败输出 |
| 扫描到 0 个文件 ≠ 无违规,必须报错 | `error-handling.md` §防假绿 |

## Forbidden Patterns(一律拒绝)

| 禁止 | 为什么 |
|---|---|
| `execution` 平面 import `fact` 平面 | I5;`boundaries` 红 |
| 手改 `src/generated/` | schema 是唯一事实来源;`check:generated` 红 |
| 绕过 `docs/04-state-machine.md` 直接改 `table.ts`(或反之) | 两处必须一致;`check:transitions` 红 |
| 在 `transition/` 用 `Date.now` / `Math.random` / `process.*` | 破坏确定性重放;`check:purity` 红 |
| mock harness / 数据库做单测 | 验证的是想象,不是现实 |
| 条件不满足时静默 skip 测试 | 假绿;输出和通过一样 |
| 为稳定而放宽断言或 schema | 用假绿换稳定性 |

---

## Code Review Checklist

提交前过一遍(与 `pnpm run check` 互补,机器查不了的部分):

- [ ] 改了 `docs/schemas/*.schema.json`?→ 已重新生成且 `check:generated` 绿
- [ ] 改了状态机文档或 `table.ts` 其中之一?→ 另一处已同步
- [ ] 新增了检查逻辑?→ 有反例验证记录(制造过违规并看到变红)
- [ ] 新增依赖外部系统的代码?→ 测试分层正确(波动性断言没进默认 check)
- [ ] 错误路径:可预期失败走 `Result`,没有吞掉意外错误
- [ ] 提交信息遵循 conventional commits(`feat(scope): …`),scope 用平面/模块名
