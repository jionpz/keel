# PRD：把 workflow-overrides 自检接进 pnpm run check

## 目标

把 `.trellis/spec/guides/workflow-overrides.md` 里三条**人工**自检，变成 `pnpm run check`
里会自动执行的断言。

## 背景

`11-05-workflow-gates` 把 Trellis 的两处人工批准收窄成三类必停，但改动分布在
`.trellis/workflow.md`、`.claude` / `.agents` / `.omp` / `.dsh` 四套平台副本里。
其中五份登记在 `.trellis/.template-hashes.json`，`trellis update` 会覆盖它们。

后果：任何人跑一次 `trellis update`，行为就静默退回「建任务前问、start 前再问」，
而没有任何东西告诉他有东西坏了 —— 除了他恰好记得去读那一页文档并手跑 grep。

这与仓库既有做法不一致：`docs/04-state-machine.md` 与代码转移表之间的一致性，
是由 `scripts/check-transition-table.ts` 在 CI 里强制的，不靠人记。

## 需求

- R1：新增 `scripts/check-workflow-overrides.ts`，沿用 `check-transition-table.ts` 的风格
  （`✓` / `✗` 输出、失败 `process.exit(1)`、**防假绿**）。
- R2：校验三类事实：
  1. **判据锚点存在** —— `workflow.md` 与三份 brainstorm `SKILL.md` 都含
     `three blocking cases`；缺失即失败（防止整段被模板重写）。
  2. **旧 gate 措辞不存在** —— 八个驱动文件里不得出现
     `task-creation consent` / `explicitly approved` / `after user confirms` /
     `must respond at least once` / `reviewed before start` / `1.4** review` /
     `ask for start review`。
  3. **平台镜像一致** —— brainstorm 三份（`.claude` / `.agents` / `.omp`）逐字节相同；
     `change-workflow.md` 三份（`.claude` / `.agents` / `.omp`）逐字节相同。
- R3：接入 `package.json` 的 `check` 链，位置在 `check:transitions` 之后。
- R4：失败信息必须给出**下一步**（指向 `workflow-overrides.md`，说明可能是模板覆盖或漏同步）。
- R5：文件缺失视为失败，不静默跳过。
- R6：不新增依赖；不联网。

## 验收标准

- AC1：`pnpm run check` 通过时新增一行 `✓` 输出，说明校验了几个文件。
- AC2：把 `workflow.md` 里任一判据锚点改掉（模拟 `trellis update` 覆盖），
  `pnpm run check` **失败**且退出码非 0，错误信息指出是哪个文件、哪一类失败。
- AC3：把 `.omp` 侧 brainstorm 版本回退一份（模拟漏同步），检查失败并指出镜像不一致。
- AC4：把旧措辞塞回任一驱动文件，检查失败并指出文件与行号。
- AC5：恢复正常内容后检查通过（先红后绿，两侧都实测）。
- AC6：`scripts/check-workflow-overrides.ts` 通过 `pnpm run lint` 与 `pnpm run typecheck`。

## 不做什么

- 不做「自动修复」。检查只报警，不重写文件 —— `trellis update` 覆盖后该用哪一版需要人判断。
- 不校验 `.dsh` / `.omp` 的 continue 文件是否与 `.claude` 逐字节相同：它们带平台封装
  （frontmatter、`--platform` 参数），本来就不同。只校验不含旧措辞。
- 不把 `workflow-overrides.md` 里的自检命令删掉。手工版仍有价值（可在不跑全量 check 时快速验证）。
- 不覆盖 `cross-layer-thinking-guide.md`：其中 `task-creation consent` 是历史事故记录。
