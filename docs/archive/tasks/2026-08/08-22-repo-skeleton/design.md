# Design — 仓库骨架与类型管线

> 本文是**本任务的技术设计**：选什么工具、为什么、四条约束各自怎么强制。

---

## 1. 设计原则

骨架期引入的依赖会活很久，且很难再撤掉。因此：

> **每个依赖都必须能说出它解决了哪条约束。**
> 说不出的，就不引入。

同理，每个目录、每条 CI 检查也都要能回答"它拦住了什么"。

---

## 2. 依赖清单与引入理由

| 依赖 | 解决什么 | 不用它会怎样 |
|---|---|---|
| `typescript` | `ADR-0002` | — |
| `vitest` | 测试；`C3` 的确定性测试 | 需自建 runner |
| `@biomejs/biome` | lint + format **一个工具** | 需 ESLint + Prettier 两套配置与插件生态 |
| `dependency-cruiser` | **`C2` `C3` 的结构性强制** | 平面边界只剩注释，必然被绕过 |
| `json-schema-to-typescript` | **`C1`** | 类型手写，schema 从此不是唯一事实来源 |
| `ajv` + `ajv-formats` | Proposal 校验流水线第 1 步 | Proposal 校验无从实现 |
| `tsx` | 跑 TS 脚本（生成器 / 检查器） | 检查脚本要先编译才能跑，CI 变复杂 |

**没有引入**：ESLint / Prettier（被 Biome 覆盖）、tsup / esbuild（`tsc` 够用）、
任何 DB / ORM（本任务 Out of scope）、任何 HTTP 框架（同上）。

### 2.1 为什么是 Biome + dependency-cruiser 而不是 ESLint 一套

Biome 快、单一工具、零插件生态负担，覆盖日常 lint 与 format。
但它**不做依赖图分析** —— 而 `C2` / `C3` 恰恰是依赖图问题。

dependency-cruiser 专门做这件事，且是独立工具、不绑 lint 生态。
两者职责不重叠：**Biome 管代码写法，dependency-cruiser 管架构边界。**

---

## 3. 工具链决定（均属 `ADR-0002` 所说的"可逆的工程选择"）

| 项 | 选择 | 理由 |
|---|---|---|
| 包管理 | **pnpm 10**（`packageManager` 字段固定 + corepack） | 严格 node_modules 杜绝幽灵依赖；workspace 能力为 PRD Q2 的日后分包留门 |
| Node | **24**（`.nvmrc` + `engines`） | 本机 v24.14.1；固定版本使 CI 与本地一致 |
| 模块 | **ESM**（`"type": "module"`） | 长期正确的方向 |
| TS module | **`nodenext`** | 这是 Node 服务的正确解析语义。代价是 import 要带 `.js` 后缀 —— 接受 |
| TS 严格度 | `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | 契约密度高，类型越严收益越大 |
| 构建 | **`tsc`** | 无需打包（Node 服务）。少一个工具 |
| 测试 | **vitest** | — |

---

## 4. 四条约束的强制方式

这是本任务的**核心设计**。每条都要能被一个反例打红。

### 4.1 `C1` · schema 是类型的唯一事实来源

```
docs/schemas/*.schema.json
        │  scripts/generate-types.ts
        ▼
src/generated/
    ├── artifacts.ts    # 由 json-schema-to-typescript 生成的类型
    └── schemas.ts      # schema 以 TS const 内联 —— 供 ajv 运行时编译
```

**为什么把 schema 内联成 `.ts` 而不是运行时读 JSON 文件**：
避免 JSON module import assertion 与打包路径问题，同时让 schema 一并落入
`C1` 的 `git diff` 检查范围。生成物**提交进 git**（PRD Constraint 2）。

**检查**：
```
pnpm run generate && git diff --exit-code src/generated/
```
手改生成物 → diff 非空 → CI 红。

生成物头部带禁改标记，且 Biome 与 dependency-cruiser 忽略该目录
（对生成代码做风格检查没有意义）。

### 4.2 `C2` · 平面边界

dependency-cruiser 规则：

| 规则 | from | 禁止 to |
|---|---|---|
| `execution-must-not-write-fact` | `^src/execution` | `^src/fact` |
| `contracts-must-stay-pure` | `^src/contracts` | 除 `^src/(generated\|shared)` 外的一切 |
| `generated-imports-nothing-local` | `^src/generated` | `^src/(control\|fact\|execution)` |

第一条直接对应中心不变量。
第二条保证契约层不反向依赖实现 —— 否则 `interface` 会慢慢长出实现细节。

> 注意：代码层的 `C2` 是数据库授权的**类比而非替代**。
> 真正的强制在 `keel_execution` 角色的权限上（`docs/03-domain-model.md` §4），
> 那部分属 v0.1 任务。这里拦的是"代码结构上就不该这么写"。

### 4.3 `C3` · 转移函数必须纯

单一手段不够，**三层叠加**：

| 层 | 手段 | 拦得住什么 |
|---|---|---|
| 1 | dependency-cruiser 禁止 `src/control/transition/**` 依赖 `node:fs` / `node:http` / `node:child_process` 等，以及 `^src/(fact\|execution)` | import 层面的 I/O |
| 2 | `scripts/check-purity.ts` 扫描禁用全局：`Date.now` / `new Date` / `Math.random` / `process.env` | 不经 import 的非确定性 |
| 3 | vitest 确定性测试：同输入重复调用，断言输出深相等 | 行为层面的兜底 |

**为什么需要第 2 层**：`Date.now()` 与 `Math.random()` 是全局，不经 import，
dependency-cruiser 看不见它们。这是必须补的洞，不是冗余。

第 2 层是文本扫描，**承认它比 AST 分析弱** —— 但它零依赖、够用，
且第 1 层已经挡住了绝大多数真实的不纯写法。

### 4.4 `C4` · 代码转移表 ⟷ 文档转移表

**问题**：`docs/04-state-machine.md` 有 31 条 Task 级转移写在 markdown 表里，
代码必须再写一遍。两份东西不会自己同步。

**本任务的解法：双向比对，而不是生成。**

```
docs/04-state-machine.md  ──解析──┐
                                  ├──▶ 比对 (id, from, to) 集合 ──▶ 不一致则 CI 红
src/control/transition/table.ts ──┘
```

`scripts/check-transition-table.ts` 解析 markdown 表格行，
提取 `(id, from, to)`，与 TS 表比对。

**通用规则的特殊处理**：`T-030` / `T-031` / `T-040` / `T-041` 的 `from` 是
"任一阶段态" / "任一非终态"，不是单个状态。检查器识别这四条为 generic，
只比对 id 存在性与 `to`，不比对 `from`。

**为什么不直接从 markdown 生成代码**：
markdown 表格解析比较脆，一旦文档排版微调就会静默产出错误的表。
比对失败只是报警，生成失败却可能悄悄生成错的东西 —— **前者的失效模式更安全**。

**为什么不反过来，让文档从数据文件生成**（PRD Q1）：
那是更彻底的方案，但要改动已定稿的文档结构。
先用比对验证这条边界是否真的会漂移；若确实频繁漂移，再考虑反转。

---

## 5. 目录结构

```
keel/
├── src/
│   ├── control/
│   │   ├── transition/          # 纯函数区 —— C3 管辖
│   │   │   ├── index.ts         #   transition() 本体
│   │   │   ├── table.ts         #   转移表 —— C4 管辖
│   │   │   └── types.ts
│   │   └── policy/              # 占位，v0.1 实现
│   ├── fact/                    # 占位，v0.1 实现
│   ├── execution/               # 占位，v0.1 实现
│   ├── contracts/               # ADR-0002 L3 的产物
│   │   ├── errors.ts            #   ErrorKind 注册表 + retryable
│   │   ├── harness-adapter.ts
│   │   ├── session-manager.ts
│   │   ├── context-builder.ts
│   │   ├── policy-engine.ts
│   │   ├── artifact-store.ts
│   │   └── index.ts
│   ├── generated/               # 禁止手改 —— C1 管辖
│   └── shared/
│       └── ids.ts               # S-* / T-* / A-* / CAP-* 的类型
├── scripts/
│   ├── generate-types.ts        # C1
│   ├── check-transition-table.ts# C4
│   └── check-purity.ts          # C3 第 2 层
├── .github/workflows/ci.yml
├── .dependency-cruiser.cjs      # C2 + C3 第 1 层
├── biome.json
├── tsconfig.json
└── package.json
```

**占位目录的处理**：`fact/` `execution/` `control/policy/` 在本任务只放一个
带说明的 `index.ts`。它们存在的意义是**让 dependency-cruiser 规则现在就能生效** ——
等到 v0.1 写实现时边界已经是硬的，而不是那时才想起来加。

---

## 6. npm scripts

| 命令 | 作用 |
|---|---|
| `generate` | schema → `src/generated/` |
| `typecheck` | `tsc --noEmit` |
| `test` | vitest |
| `lint` | biome |
| `boundaries` | dependency-cruiser |
| `check:generated` | `C1` —— 重新生成后比对 git diff |
| `check:transitions` | `C4` |
| `check:purity` | `C3` 第 2 层 |
| **`check`** | **以上全部** —— CI 与本地跑同一条命令 |

> `check` 聚合是刻意的：CI 与本地必须跑**同一条命令**，
> 否则会出现"本地过了 CI 红"的常见摩擦，而人们解决它的方式通常是放宽 CI。

---

## 7. 契约翻译的范围（`ADR-0002` L3）

只翻译标注 `[v0.1 必须]` 的方法，共：

| 契约 | v0.1 必须的方法 |
|---|---|
| `HarnessAdapter` | `describe` `startRun` `awaitResult` `collectChanges` `interrupt` `dispose` |
| `SessionManager` | `selectAdapter` `open` `advance` `checkpoint` `restore` `close` |
| `ContextBuilder` | `build` |
| `PolicyEngine` | `evaluate` `validate` |
| `ArtifactStore` | `commit` `get` `latest` `history` `getAsOf` `appendEvent` `readEvents` |

`[可延后]` 的方法（`resume` `observe` `estimate` `explain` `project`）
以注释形式在 interface 中保留位置，**不声明** —— 声明了就会有人去实现它。

产物类型一律来自 `src/generated/`，**契约文件里不重复定义任何产物形状**。

---

## 8. 风险

| 风险 | 对策 |
|---|---|
| markdown 表格解析脆 | 只提取 `(id, from, to)` 三列，不依赖列数与排版；解析到 0 行即报错（防止"解析失败 = 无差异"的假绿） |
| `nodenext` 的 `.js` 后缀摩擦 | 接受。Biome 可自动补全 import |
| 生成物入库导致 diff 噪音 | 可接受 —— 这正是 `C1` 的检查手段 |
| 约束太严拖慢 v0.1 开发 | 若确实如此，**改约束要走 ADR**，不允许临时注释掉规则 |
| 反例验证忘了还原 | `implement.md` 把还原列为独立步骤，且最终 `check` 必须为绿 |

---

## 9. 兼容与回滚

纯新增：不改动 `docs/` 内容（除非发现出入），不影响既有文档校验。
回滚 = `git revert` 单个 commit。
