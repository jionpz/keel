# Implement — 仓库骨架与类型管线

> 顺序有依赖：约束的**强制机制**要先于被约束的代码建立，
> 否则代码写完才加规则，一定会先看到一堆报错然后倾向于放宽规则。

---

## Stage 1 · 工程底座

- [ ] 1.1 `package.json`：ESM、`packageManager` 固定 pnpm、`engines.node`
- [ ] 1.2 `.nvmrc`（24）
- [ ] 1.3 `tsconfig.json`：`nodenext`、`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`
- [ ] 1.4 `biome.json`：忽略 `src/generated/`
- [ ] 1.5 `.gitignore` 补充 `node_modules/` `dist/`
- [ ] 1.6 安装依赖

**验收**：`pnpm install` 成功；`pnpm exec tsc --noEmit` 在空 `src/` 上通过。

---

## Stage 2 · 约束机制先行

**先建规则，再写被规则约束的代码。**

- [ ] 2.1 建三平面目录 + 占位 `index.ts`（让边界规则现在就有作用对象）
- [ ] 2.2 `.dependency-cruiser.cjs`：
      - `execution-must-not-write-fact`：`^src/execution` ✗→ `^src/fact`
      - `contracts-must-stay-pure`：`^src/contracts` 仅可依赖 `^src/(generated|shared)`
      - `transition-must-be-pure`：`^src/control/transition` ✗→ I/O 内置模块与 `^src/(fact|execution)`
      - `generated-imports-nothing-local`
- [ ] 2.3 `scripts/check-purity.ts`：扫描禁用全局 `Date.now` / `new Date` / `Math.random` / `process.env`
- [ ] 2.4 接入 npm scripts：`boundaries` / `check:purity`

**验收**：两条命令都能跑，且在当前（空）代码上通过。

---

## Stage 3 · schema → 类型管线（`C1`）

- [ ] 3.1 `scripts/generate-types.ts`：读 `docs/schemas/*.schema.json`
      → `src/generated/artifacts.ts`（类型）+ `src/generated/schemas.ts`（schema 内联为 const）
- [ ] 3.2 生成物头部写入禁改标记
- [ ] 3.3 `scripts/` 里加 `check:generated`：重新生成后 `git diff --exit-code src/generated/`
- [ ] 3.4 运行生成，产物入库

**验收**：8 份 schema 全部产出类型；`A-RFC` 的 `policy_facts` 等嵌套结构类型正确。

---

## Stage 4 · 共享 ID 类型

- [ ] 4.1 `src/shared/ids.ts`：`TaskStatus`（15 个 `S-*`）、`ControlMode`、`RunStatus`、
      `TransitionId`、`ArtifactKind`、`CapabilityId`

来源是 `docs/02-glossary.md` 与 `docs/04-state-machine.md`。

**验收**：状态数与文档一致（15 个）。

---

## Stage 5 · 契约 TS 接口（`ADR-0002` L3）

- [ ] 5.1 `src/contracts/errors.ts`：`ErrorKind` 注册表 + `retryable` 映射
      （10 个 kind，见 `docs/05-contracts/README.md`）
- [ ] 5.2 `harness-adapter.ts`：6 个 `[v0.1 必须]` 方法 + `CAP-*` + `HarnessDescriptor` / `RunSpec` / `RunResult` / `WorkspaceDiff`
- [ ] 5.3 `session-manager.ts`：6 个方法 + `Proposal` / `ProposalVerdict`
- [ ] 5.4 `context-builder.ts`：`build` + `Context` / `ContextSection` / `DroppedSection`
- [ ] 5.5 `policy-engine.ts`：`evaluate` / `validate` + `Rule` + 严格性偏序
- [ ] 5.6 `artifact-store.ts`：7 个方法
- [ ] 5.7 `index.ts` 汇出

**约束**：产物形状一律 import 自 `src/generated/`，契约文件里**不重复定义**。
`[可延后]` 的方法只留注释，不声明。

**验收**：`pnpm run boundaries` 通过（证明 contracts 层没有反向依赖）。

---

## Stage 6 · 转移表与纯函数（`C3` `C4`）

- [ ] 6.1 `src/control/transition/types.ts`：`TransitionEvent` / `SideEffect` / `TransitionResult`
- [ ] 6.2 `src/control/transition/table.ts`：录入 `docs/04-state-machine.md` 的全部 Task 级转移
      （27 条显式 + 4 条通用规则）
- [ ] 6.3 `src/control/transition/index.ts`：`transition()` 纯函数
- [ ] 6.4 `scripts/check-transition-table.ts`：解析 markdown 表 ↔ 比对 TS 表
      - 解析到 0 行必须报错（防止"解析失败 = 无差异"的假绿）
      - 通用规则只比对 id 与 `to`
- [ ] 6.5 测试：转移覆盖、确定性（同输入重复调用输出深相等）、副作用只出现在返回值中

**验收**：`pnpm run check:transitions` 通过；`pnpm run check:purity` 通过。

---

## Stage 7 · CI

- [ ] 7.1 `.github/workflows/ci.yml`：checkout → setup-node(24) → corepack/pnpm → install → **`pnpm run check`**
- [ ] 7.2 `package.json` 的 `check` 聚合全部检查

**约束**：CI 只跑 `pnpm run check` 这一条命令 —— 与本地完全一致。

---

## Stage 8 · 反例验证 `[本任务的核心验收]`

> **光看 CI 绿证明不了任何事** —— 一个什么都不检查的 CI 也是绿的。
> 必须逐条制造违规，确认检查真的会红。

每条：制造违规 → 跑 `pnpm run check` → **确认失败并记录报错信息** → 还原。

- [ ] 8.1 `C1`：手改 `src/generated/artifacts.ts` 中一个类型 → 期望 `check:generated` 失败
- [ ] 8.2 `C2`：在 `src/execution/index.ts` 中 import `src/fact/` → 期望 `boundaries` 失败
- [ ] 8.3 `C3`：在 `src/control/transition/index.ts` 中 import `node:fs` → 期望 `boundaries` 失败
- [ ] 8.4 `C3b`：在同一文件中写 `Date.now()` → 期望 `check:purity` 失败
- [ ] 8.5 `C4`：删掉 `table.ts` 中一条 `T-*` → 期望 `check:transitions` 失败
- [ ] 8.6 **全部还原**，`pnpm run check` 为绿
- [ ] 8.7 把五次验证的结果记入 `prd.md` 的验收执行记录

**这一步不允许跳过。** 未经反例验证的检查，等同于没有检查。

---

## Stage 9 · 收口

- [ ] 9.1 若实现过程中发现 `docs/` 与实现有出入，同步文档（而不是让代码将就）
- [ ] 9.2 更新 `docs/README.md` / 根 `README.md` 的状态段
- [ ] 9.3 `.trellis/spec/` 判断：是否已有**真实**代码模式值得记录（无则明确说明不写）
- [ ] 9.4 逐条勾 `prd.md` 验收标准
- [ ] 9.5 commit

---

## 回滚点

| 时机 | 方式 |
|---|---|
| Stage 8 发现某条约束根本拦不住 | **不放宽约束**，改强制手段；改不动则在 `prd.md` 如实记录该约束未被机制化 |
| 整体放弃 | 纯新增，`git revert` 单个 commit |

---

## 与 Trellis 流程的对应

- Stage 1–7 = Phase 2.1 Implement
- Stage 8 = Phase 2.2 Quality check（**本任务的 check 就是反例验证**）
- Stage 9 = Phase 3
