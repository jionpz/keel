# Workflow Overrides · 本项目对 Trellis 工作流的本地覆盖

> 来源：`11-05-workflow-gates`（2026-11-05）。
> **跑过 `trellis update` 之后必须读这一页**，否则你会在不知情的情况下退回旧行为。

## 改了什么

Trellis 默认要求每个任务停下来问两次：建任务前一次、计划写完再问一次「可以开工吗」。
本项目把这两次去掉，只保留**三类必须停下来问**的情况。

| 文件 | 改动 | `trellis update` 会覆盖？ |
|---|---|---|
| `.trellis/workflow.md` | `Request Triage` 新增「When you must stop and ask」；`no_task` / `planning` / `planning-inline` / `in_progress` breadcrumb 同步；1.4 不再等批准 | 是 |
| `.claude/skills/trellis-brainstorm/SKILL.md` | Planning Contract / Planning Flow / Question Rules / Convergence Gate / Quality Bar 去掉「等待批准」，加「非必停决定怎么处理」 | 是 |
| `.agents/skills/trellis-brainstorm/SKILL.md` | 与 `.claude/` 侧逐字节相同 | 否 |
| `.omp/skills/trellis-brainstorm/SKILL.md` | 与 `.claude/` 侧逐字节相同 | 是 |
| `.claude/commands/trellis/continue.md` | 1.4 路由改成自检口径 | 是 |
| `.agents/skills/source-command-trellis-continue/SKILL.md` | 同口径，但**带 YAML frontmatter 与平台参数**，不是逐字节副本 | 否 |
| `.omp/commands/trellis-continue.md` | 同口径，**带平台封装** | 是 |
| `.dsh/skills/trellis-continue/SKILL.md` | 同口径，**带平台封装** | 是 |
| `.claude` / `.agents` / `.omp` 的 `trellis-meta/.../change-workflow.md` | 路由表改成自检口径（三份相同） | 是 |

「会覆盖」= 在 `.trellis/.template-hashes.json` 里登记过。**带平台封装的文件不能用 `cp` 互拷**，
只能定点改那一行——它的 frontmatter 与 `--platform` 参数是平台专用的。

## 判据（唯一权威版在 `.trellis/workflow.md` 的 Request Triage）

1. **未决的产品 / 范围 / 风险取舍** —— 仓库证据与用户原话都不能定，
   且不同选择导出**不同的验收标准**
2. **请求超出单任务范围** —— 需要拆父子任务，或需要用户决定先做哪个
3. **破坏性 / 不可逆操作** —— 全局红线清单，以及任何推送远端

**技术细节不是决策**：实现路径、命名、测试写法自己定。

## 不属于必停的用户决定怎么办

这是本次改动的关键补充，也是最容易出歧义的地方。

一个决定属于用户（产品 / UX / 兼容性 / 范围），但两个选项导出**相同验收标准**时，
它**不是**必停项。此时：

1. 自己决定；
2. 写进 `prd.md` 的 Key Decisions；
3. 在开工第一句话里点名。

被禁止的是**静默决定**，不是决定本身。否则「绝不替用户做产品决定」会退化成
「每一处措辞都要问一次」——那正是这次要消掉的东西。

反过来，若某个决定会改变验收标准，它就落进判据 1，必须问，不能靠「记一笔」绕过。

## 替代机制：开工第一句话

去掉「开工前批准」之后，纠偏点后移到 **`task.py start` 之后的第一条输出**：

> 用一句话说明你理解的 Goal、In Scope、本次不做的事，以及任何你未经询问就记下的决定。

这不是客套。它是在用户还没看到任何代码改动之前，唯一能暴露「AI 理解偏了」的位置。
省略这句话 = 把纠偏点推迟到第一个 commit，那时成本已经高了一个量级。
`[workflow-state:in_progress]` 里也留了一句「首轮没说就现在说」，防止它随 breadcrumb 切换静默消失。

## 自检（`trellis update` 之后、在仓库根目录跑）

```bash
# 1) 判据锚点：workflow.md 与三份 brainstorm 各 ≥1
grep -c "three blocking cases" .trellis/workflow.md \
  .claude/skills/trellis-brainstorm/SKILL.md \
  .agents/skills/trellis-brainstorm/SKILL.md \
  .omp/skills/trellis-brainstorm/SKILL.md

# 2) 旧 gate 措辞：应无输出（exit 1）
grep -n "task-creation consent\|explicitly approved\|after user confirms\|must respond at least once\|reviewed before start\|1\.4\*\* review\|ask for start review" \
  .trellis/workflow.md \
  .claude/skills/trellis-brainstorm/SKILL.md \
  .agents/skills/trellis-brainstorm/SKILL.md \
  .omp/skills/trellis-brainstorm/SKILL.md \
  .claude/commands/trellis/continue.md \
  .agents/skills/source-command-trellis-continue/SKILL.md \
  .omp/commands/trellis-continue.md \
  .dsh/skills/trellis-continue/SKILL.md

# 3) 平台镜像：应无输出（exit 0）
diff -q .claude/skills/trellis-brainstorm/SKILL.md .agents/skills/trellis-brainstorm/SKILL.md
diff -q .claude/skills/trellis-brainstorm/SKILL.md .omp/skills/trellis-brainstorm/SKILL.md
diff -q .claude/skills/trellis-meta/references/customize-local/change-workflow.md .agents/skills/trellis-meta/references/customize-local/change-workflow.md
diff -q .claude/skills/trellis-meta/references/customize-local/change-workflow.md .omp/skills/trellis-meta/references/customize-local/change-workflow.md
```

> 文件必须逐个列出，不能塞进一个 `$FILES` 变量：本机默认 shell 是 zsh，
> **未加引号的变量不会按空白分词**，会整串当成一个路径而报 No such file。

判定：第 1 条每个文件 ≥1；第 2、3 条**无输出**。
注意第 2 条匹配不到时 grep 返回 **exit 1**，那是通过而不是失败——别放进 `set -e` 脚本里。

**刻意不扫的文件**：`.trellis/spec/guides/cross-layer-thinking-guide.md` 里出现
「task-creation consent」是在记录一次历史事故（beta 文档污染），改掉它等于篡改记录。

## 失败怎么归因

| 失败项 | 最可能的原因 | 处理 |
|---|---|---|
| 第 1 条 | `trellis update` 用模板重写了 `workflow.md` 或某份 brainstorm `SKILL.md` | 按本页表格恢复，或 `git log -p -- .trellis/workflow.md` 找回改动提交 |
| 第 2 条 | 同上；或某个平台副本没跟着改（`.omp` / `.dsh` 最容易漏） | 按本页表格逐个文件恢复；带封装的文件**定点改**，不要 `cp` |
| 第 3 条 | 改了 `.claude/` 侧却忘了同步 `.agents/` / `.omp/` 侧 | 重新 `cp`；但 continue 那三份带封装，不能 `cp` |

## 为什么不用 config 开关

`.trellis/config.yaml` 没有「关闭批准 gate」的选项，这是有意的：判据必须跟着具体
项目走，一个布尔开关会让「关掉之后 AI 该在什么时候停」重新变成未定义行为。
