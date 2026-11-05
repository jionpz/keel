# 实施计划：workflow-overrides 自检接入 check

## 1. 新建 `scripts/check-workflow-overrides.ts`

结构照抄 `scripts/check-transition-table.ts` 的骨架：

- 顶部注释写清**为什么比对而不是生成**（生成失败会悄悄产出错的东西，比对失败只是报警）。
- 常量表：`DRIVING_FILES`（8 个，含行号可定位）、`MIRROR_GROUPS`（两组三份）。
- `readOrFail(path)`：读不到就 `✗ 文件缺失` 并计入问题（R5，不静默跳过）。
- 三组断言各返回 `problems: string[]`。
- **防假绿**：三个驱动文件里一个锚点都没找到时，单独报「解析/文件可能整体被替换」，
  不能因为 `problems` 为空就当通过。
- 结尾统一输出 `✓` 或 `✗` + 下一步。

## 2. 接入 `package.json`

```json
"check:workflow": "tsx scripts/check-workflow-overrides.ts",
"check": "... && pnpm run check:purity && pnpm run check:workflow && pnpm run test"
```

放在 `check:transitions` / `check:purity` 之后、`test` 之前。

## 3. 先红后绿（AC2 / AC3 / AC4 / AC5）

逐个制造真反例，确认**先失败再恢复**：

- [x] AC2：临时把 `workflow.md` 的 `three blocking cases` 改成 `two blocking cases` → 应失败
- [x] AC3：临时 `cp` 一份旧版 brainstorm 到 `.omp/` → 应报镜像不一致
- [x] AC4：临时把 `ask for start review` 塞进 `.dsh/skills/trellis-continue/SKILL.md` → 应报行号
- [x] AC5：全部恢复 → 应通过

每次改完立刻 `git checkout --` 恢复，别把反例留在工作区。

## 4. 更新文档

- [x] `workflow-overrides.md` 的自检段加一句：这三条现在由 `pnpm run check` 自动执行，
  手工版保留用于快速验证。
- [x] `.trellis/spec/guides/index.md` 那一行的说明补上「已接入 check」。

## 5. 提交前

- [x] `pnpm run check` 全绿
- [x] `git status` 只含本任务文件
