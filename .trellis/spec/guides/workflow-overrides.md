# Workflow Overrides · 本项目对 Trellis 工作流的本地覆盖

> 来源：`11-05-workflow-gates`（2026-11-05）。
> **跑过 `trellis update` 之后必须读这一页**，否则你会在不知情的情况下退回旧行为。

## 改了什么

Trellis 默认要求每个任务停下来问两次：建任务前一次、计划写完再问一次「可以开工吗」。
本项目把这两次去掉，只保留**三类必须停下来问**的情况。

| 文件 | 改动 |
|---|---|
| `.trellis/workflow.md` | `Request Triage` 新增「When you must stop and ask」；`[workflow-state:no_task]` / `[workflow-state:planning]` breadcrumb 同步；1.4 不再等批准 |
| `.claude/skills/trellis-brainstorm/SKILL.md` | Planning Contract / Planning Flow / Question Rules / Quality Bar 去掉「等待批准」 |
| `.claude/commands/trellis/continue.md` | 1.4 路由改成自检口径 |
| `.agents/skills/trellis-brainstorm/SKILL.md` | 与 `.claude/` 侧逐字节相同 |
| `.agents/skills/source-command-trellis-continue/SKILL.md` | 同 continue.md |

## 判据（唯一权威版在 `.trellis/workflow.md` 的 Request Triage）

1. **未决的产品 / 范围 / 风险取舍** —— 仓库证据与用户原话都不能定，
   且不同选择导出**不同的验收标准**
2. **请求超出单任务范围** —— 需要拆父子任务，或需要用户决定先做哪个
3. **破坏性 / 不可逆操作** —— 全局红线清单，以及任何推送远端

**技术细节不是决策**：实现路径、命名、测试写法自己定。

## 替代机制：开工第一句话

去掉「开工前批准」之后，纠偏点后移到 **`task.py start` 之后的第一条输出**：

> 用一句话说明你理解的 Goal、In Scope、以及本次不做的事。

这不是客套。它是在用户还没看到任何代码改动之前，唯一能暴露「AI 理解偏了」的位置。
省略这句话 = 把纠偏点推迟到第一个 commit，那时成本已经高了一个量级。

## 自检（`trellis update` 之后跑一次）

```bash
grep -c "three blocking cases" \
  .trellis/workflow.md \
  .claude/skills/trellis-brainstorm/SKILL.md
grep -rn "task-creation consent\|explicitly approved\|after user confirms\|must respond at least once\|reviewed before start\|1\.4\*\* review" \
  .trellis/workflow.md .claude/skills/trellis-brainstorm/SKILL.md \
  .claude/commands/trellis/continue.md
diff -q .claude/skills/trellis-brainstorm/SKILL.md \
        .agents/skills/trellis-brainstorm/SKILL.md
```

- 第一条：两个文件各 ≥1
- 第二条：无输出
- 第三条：无输出

前三个文件在 `.trellis/.template-hashes.json` 里登记过，`trellis update` 会覆盖它们；
`.agents/` 下两份没有登记，不会被覆盖。所以**失败原因的判定要分开看**：

| 失败项 | 最可能的原因 | 处理 |
|---|---|---|
| 第一条 / 第二条 | `trellis update` 用模板重写了 `.trellis/workflow.md` 或 `.claude/skills/trellis-brainstorm/SKILL.md` | 按本页表格恢复，或 `git log -- .trellis/workflow.md` 找回改动提交 |
| 第三条 | 改了 `.claude/` 侧却忘了 `cp` 到 `.agents/` 侧 | 重新拷一次，不要改 `.agents/` 侧内容 |

## 为什么不用 config 开关

`.trellis/config.yaml` 没有「关闭批准 gate」的选项，这是有意的：判据必须跟着具体
项目走，一个布尔开关会让「关掉之后 AI 该在什么时候停」重新变成未定义行为。
