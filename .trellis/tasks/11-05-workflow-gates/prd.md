# 收窄 Trellis 工作流的人工确认点

## Goal

把「每开一个任务固定停下来两次」改成「只在真正需要人拍板时才停」。

## 背景

用户反馈：建任务前要问一次「要不要建任务」，计划写完再问一次「可以开工吗」。
keel 产品侧刚做完两项减少人工闸门的改动（policy 放行带、人工裁决 TTL），
开发流程本身却还在制造闸门 —— 两边不一致。

## Requirements

- **R1 建任务不再需要单独确认**：请求落在单任务范围内、且无互斥方案时，
  直接 `task.py create` 并进入规划。
- **R2 计划完成后不再等人批准**：artifact 自检达标即 `task.py start`。
  自检项：AC 可测、复杂任务有 `design.md` + `implement.md`、jsonl 有真实条目。
- **R3 保留「必须停下来问」的判据**，且写清楚（见下），不靠 AI 自由裁量：
  1. 未决的**产品 / 范围 / 风险取舍** —— 仓库证据与用户原话都不能定，
     且不同选择会导出不同的验收标准；
  2. 请求**超出单任务范围** —— 需要拆父子任务，或需要用户决定先做哪个；
  3. **破坏性 / 不可逆操作** —— 全局红线清单，以及推送远端。
- **R4 保留 plan-before-code**：Phase 1 仍要写 artifact，只是「批准」这个动作消失。
- **R5 保留 Phase 2.2 check、Phase 3.3 spec、Phase 3.4 commit**。
- **R6 单一事实源**：breadcrumb block 与 platform entry files
  （`continue.md`、`trellis-brainstorm/SKILL.md`）必须同步，不能只改一处 ——
  否则 hook 每轮注入的旧文案会持续对抗新规则。

## 不改

- 全局安全红线（`rm -rf` / `git push --force` / 删生产配置 / `sudo`）
- `trellis-check` 的独立性与 Phase 2.2 的必做性
- 提交前 review diff 的纪律；仍不推远端

## Acceptance Criteria

- [ ] AC1 `grep` 校验：`workflow.md` / `continue.md` / `trellis-brainstorm/SKILL.md`
      里不再有「默认先问建任务」「必须等用户明确批准才能 start」的表述
- [ ] AC2 `workflow.md` 与 `trellis-brainstorm/SKILL.md` 各有一份「必须停下来问」的三条判据，
      措辞一致；`continue.md` 只作入口指针（指向 workflow.md 的 Request Triage），不复制判据
- [ ] AC3 模拟三类请求的问询次数：小修复 0 次、中等功能 0 次、有方案分叉 1 次
      （用当前会话已发生的建任务流程做对照推演，写进 `implement.md` 的验收记录）
- [ ] AC4 `.agents/skills/` 镜像与 `.claude/skills/` 内容一致（`diff -q` 通过）
- [ ] AC5 `trellis update` 覆盖风险的处置已写进 `.trellis/spec/guides/`

## Notes

- 这是规则改动，不涉及产品代码；但它改变**以后每个会话**的行为，比代码改动更需要精确。
- 判据要写成可判别的事实，不写「酌情」「合理时」这类不可执行的词。
