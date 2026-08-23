# 目录结构

> 记录**实际**结构，不是理想结构。
> 来源：`08-22-repo-skeleton` 任务。

---

## 三平面

目录不只是组织方式，**它承载架构约束**。
边界由 `.dependency-cruiser.cjs` 强制，违反则 `pnpm run boundaries` 失败。

```
src/
├── control/        # 决定下一步做什么。绝不直接调用 LLM，必须可确定性重放
│   ├── transition/ #   纯函数区 —— 受 ADR-0003 约束，见下
│   └── policy/
├── fact/           # 唯一事实来源。只由 Control Plane 写入
├── execution/      # 干活。⛔ 不得 import src/fact
├── contracts/      # 接口定义。⛔ 只能依赖 src/generated 与 src/shared
├── generated/      # 由 docs/schemas/ 生成 —— ⛔ 禁止手改
└── shared/         # 跨平面共享的 ID 与类型
scripts/            # 构建与检查脚本，不受平面约束
```

### 已生效的边界规则

| 规则 | 禁止 |
|---|---|
| `execution-must-not-write-fact` | `src/execution` → `src/fact` |
| `fact-must-not-depend-on-execution` | `src/fact` → `src/execution` |
| `contracts-must-stay-pure` | `src/contracts` → 除 `generated` / `shared` 外的一切 |
| `generated-must-not-import-local` | `src/generated` → 任何手写代码 |
| `transition-must-be-pure` | `src/control/transition` → 除自身 / `shared` / `generated` 外的一切 |
| `production-must-not-import-tests` | 非测试文件 → `*.test.ts` |
| `no-circular` | 任何循环依赖 |

**要放宽任何一条，走 ADR** —— 不要在配置里临时注释掉。

---

## `src/generated/` 的纪律

由 `pnpm run generate` 从 `docs/schemas/*.schema.json` 生成，**提交进 git**。

- 手改会被 `pnpm run check:generated` 抓住（与 `HEAD` 比对）
- 要改产物形状，改 **schema** 然后重新生成
- Biome 与 dependency-cruiser 都跳过该目录 —— 对生成代码做风格检查没有意义

---

## `src/control/transition/` 的纪律

`ADR-0003` 硬约束：转移必须是纯函数。三层强制：

1. dependency-cruiser —— 不得 import 任何外部模块（含 Node 内置与 npm）
2. `scripts/check-purity.ts` —— 不得使用 `Date.now` / `new Date` / `Math.random` / `process.*` 这类全局
3. 单元测试 —— 同输入重复调用输出深相等、不修改入参

副作用**只能作为返回值中的描述**，由外层执行器实施。

另有 `scripts/check-transition-table.ts`：代码转移表必须与
`docs/04-state-machine.md` §2 一致。**改了文档不改代码（或反之）会红。**

---

## 文件命名

| 类型 | 约定 | 例 |
|---|---|---|
| 模块 | kebab-case | `harness-adapter.ts` |
| 测试 | 与被测文件同目录，`*.test.ts` | `transition.test.ts` |
| 目录入口 | `index.ts` | — |

---

## import 写法

ESM + `moduleResolution: nodenext`，因此**相对 import 必须带 `.js` 后缀**（即使源文件是 `.ts`）：

```ts
import { transition } from './index.js'                 // ✅
import type { TaskStatus } from '../../shared/ids.js'   // ✅
import { transition } from './index'                    // ❌ 解析失败
```

类型 import 一律用 `import type`（已开启 `verbatimModuleSyntax`）。
