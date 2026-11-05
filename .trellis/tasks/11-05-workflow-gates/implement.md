# 实施计划：收窄 Trellis 工作流的人工确认点

> 顺序是有意的：先改 `workflow.md`（hook 每轮读的正文），再改 skill（规划行为的驱动），
> 最后改 command 与镜像。反过来的话，中途任何一轮对话都处在「hook 说必须问、
> skill 说不用问」的分裂状态。

## 0. 前置

- [ ] `git status --porcelain` 为空
- [ ] 已通读：`.trellis/workflow.md`、`.claude/skills/trellis-brainstorm/SKILL.md`、
      `.claude/commands/trellis/continue.md`

## 1. `.trellis/workflow.md`（11 处）

按 `design.md` §4.1 表格逐条改。改完自查：

- [ ] `grep -n "consent" .trellis/workflow.md` 无残留
- [ ] `grep -n "user confirms\|User confirms" .trellis/workflow.md` 无残留
- [ ] 三份文件里的判据段文字**逐字相同**

## 2. `.claude/skills/trellis-brainstorm/SKILL.md`

- [ ] 按 `design.md` §4.2 改写 Planning Contract / Planning Flow / Question Rules /
      Convergence Gate / Quality Bar
- [ ] 保留 Evidence Rule（L16-24）原样 —— 它不是 gate，是「先查再问」的纪律
- [ ] 保留 Thinking Framework（L84-125）原样

## 3. `.claude/commands/trellis/continue.md`

- [ ] L30 改成自检口径

## 4. 镜像到 `.agents/skills/`

- [ ] `cp` 两份 SKILL.md 到对应目录（改完再拷，避免中间态）
- [ ] `diff -q` 两侧逐字节一致（AC4）

## 5. 覆盖项记录

- [ ] 新建 `.trellis/spec/guides/workflow-overrides.md`：改了哪几个文件、判据锚点、
      自检命令、`trellis update` 后怎么恢复
- [ ] `.trellis/spec/guides/index.md` 表格加一行

## 6. 校验（AC1 / AC2）

```bash
grep -c "什么时候必须停下来问" .trellis/workflow.md \
  .claude/skills/trellis-brainstorm/SKILL.md \
  .claude/commands/trellis/continue.md
grep -rn "task-creation consent\|explicitly approves\|after user confirms" \
  .trellis/workflow.md .claude/skills/trellis-brainstorm/SKILL.md \
  .claude/commands/trellis/continue.md
```

- [ ] 第一条：三个文件都 ≥1
- [ ] 第二条：无输出

## 7. 验收记录（AC3）

按新规则推演三类请求，写进本节：

| 请求类型 | 旧流程问几次 | 新流程问几次 | 依据 |
|---|---|---|---|
| 小修复（「把 X 的错误信息改清楚」） | 2（建任务 / 批准计划） | 0 | 单任务、无方案分叉 |
| 中等功能（「给控制台加导出」） | 2 | 0 | 单任务，技术选择自己定 |
| 有方案分叉（「A 用表 B 用事件，选哪个」） | 2 | 1 | 判据 1：两个选项的 AC 不同 |

- [x] 填完并核对与 `design.md` §3 判据一致

实测记录：本任务自身就是第一次应用 —— 用户说「开任务」后直接
`task.py create` → 写 `prd/design/implement` → `task.py start`，中间没有停下来等批准。
旧流程在同一位置会停两次（问「要建任务吗」、问「可以 start 吗」）。

## 8. 提交前

- [ ] `pnpm run check` 仍绿（本次不动代码，但确认没有误伤）
- [ ] `git status` 只含本任务文件
- [ ] 提交信息说明「这是规则改动，影响所有后续会话」
