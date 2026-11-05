# 设计：收窄 Trellis 工作流的人工确认点

## 1. 改动的本质

Trellis 现在的 phase transition 条件是「用户批准」：
写完 artifact → 呈现总结 → **停下** → 等用户说可以 → `task.py start`。

改成「自检达标」：
写完 artifact → 呈现总结 → **检查三条判据** → 无未决决策则直接 `task.py start`。

变的只有**阻断条件**，Phase 1 的证据工作（inspect → converge → PRD pass）一步不少。

## 2. 为什么这是安全的

原来那道批准 gate 防的是「AI 自以为想清楚了，其实理解错了」。这个风险真实存在，
拆开看它实际由四层承担：

| 层 | 作用 | 本次是否保留 |
|---|---|---|
| 证据先行 | 仓库能答的不问人 | ✅ 不动 |
| Requirement Convergence Gate | AC 可观测、范围显式 | ✅ 不动 |
| PRD Convergence Pass | 文档不自相矛盾 | ✅ 不动 |
| 用户批准 | 纠偏 | ⚠️ **改为不阻塞** |

第四层不能直接删 —— 删了就没人纠偏了。替代方案是**降低阻断、保持可见**：

> `task.py start` 之后的第一条输出，必须是一句话的「我按什么理解开工」，
> 列出 Goal + In Scope + 本次不做的事。用户看到不对可以立刻叫停。

这比「批准」轻，但纠偏能力保留：批准是在开工前拦，这句话是在开工后第一秒暴露。
差别是 AI 不再替用户做「要不要现在打断」的决定。

## 3. 新的判定规则（三份文件一字不差地复用）

```md
## 什么时候必须停下来问

默认自动推进。只有下面三类情况停下来：

1. **未决的产品 / 范围 / 风险取舍** —— 仓库证据和用户原话都不能定，
   且不同选择会导出**不同的验收标准**。
2. **请求超出单任务范围** —— 需要拆父子任务，或需要用户决定先做哪个。
3. **破坏性 / 不可逆操作** —— 全局红线清单（`rm -rf` / `git push --force` /
   删生产配置 / `sudo`），以及任何推送远端。

技术细节不是决策：实现路径、命名、测试写法自己定，不要问。
```

「不同选择会导出不同的验收标准」是这条判据的可执行形式 —— 它把「要不要问」
从主观判断变成一次对照：两个选项写成 AC 长得一样吗？一样就不问。

## 4. 改动清单

### 4.1 `.trellis/workflow.md`（本地文件，官方文档明确可改）

| 位置 | 现状 | 改成 |
|---|---|---|
| L147 Phase Index | `classify, get task-creation consent, then write planning artifacts` | `classify, create the task, write planning artifacts, then start` |
| L152-156 Request Triage | 三条都以「ask whether…」开头 | 换成 §3 的三条判据 + 「默认直接建任务」 |
| L177-180 `[workflow-state:no_task]` | `ask for task-creation consent before creating any Trellis task` | 同上（这是 hook 每轮注入的正文） |
| L183 1.0 标题 | `(only after task-creation consent)` | `(no separate consent step — see Request Triage)` |
| L188-206 `[workflow-state:planning]` | `ask for review before task.py start` | `自己检查 §3 三条；无未决则直接 start，start 后一句话说明理解` |
| L293 Guardrails | `Task creation approval is not implementation approval; implementation waits for task.py start after artifact review` | `Planning artifacts still gate start — but the gate is a self-check, not a user approval` |
| L310 Phase 1 Goal | `get task-creation consent when a task is needed` | `create the task when one is needed` |
| L314 | `Create the task directory only after task-creation consent.` | `Create the task directory once the request is classified as task-scoped.` |
| L436-443 1.4 | `After artifact review, flip the task status` | `After the self-check passes, flip the task status` + 新增「开工第一句话」要求 |
| L449-457 1.5 表 | `User confirms task should enter implementation` | `Self-check passed (see Request Triage)` |
| L654 Critical invariant | `No active task must triage first and ask for task-creation consent` | `No active task must triage first; a task-scoped request creates the task directly` |

### 4.2 `.claude/skills/trellis-brainstorm/SKILL.md`

这是真正驱动规划行为的文件，改动集中在「Non-Negotiable Planning Contract」与 Planning Flow：

| 行 | 改成 |
|---|---|
| L10 | 删「Task-creation consent is also not implementation approval」→ 改为「Planning still happens; what disappears is the wait-for-approval step」 |
| L12 | 整条删除（「user must respond at least once」是最硬的那道门） |
| L14 | `While any user-owned … remains unresolved, ask one question and stop` → 保留（这就是判据 1），但补「技术细节不算」 |
| L32 Preconditions | `only after task-creation consent has been given` → `once the request is classified as task-scoped` |
| L56 / L60 / L61 | 「ask then stop」「present and stop」「only a subsequent approval authorizes start」→ 合成一条：呈现总结 → 自检 §3 → 无未决即 start |
| L78 / L80 / L82 | 三处关于「批准」的强调同步改写 |
| L138 | `may not skip … fresh implementation approval` → `self-check` |
| L198 | Quality Bar 最后一条 `user explicitly approved` → `self-check 通过，且开工时说明了理解` |
| L200 | `Do not start implementation merely because the user originally asked for implementation` → 保留精神：`Do not start while a §3 decision is unresolved.` |

### 4.3 `.claude/commands/trellis/continue.md`

L30：`(ask for start review; only run task.py start after user confirms)` → `(run task.py start once the self-check passes)`

### 4.4 `.agents/skills/` 镜像

`.agents/skills/trellis-brainstorm/SKILL.md` 与
`.agents/skills/source-command-trellis-continue/SKILL.md` 当前与 `.claude/` 侧**逐字节相同**，
同步修改，改完用 `diff -q` 校验（AC4）。

## 5. `trellis update` 覆盖风险

`workflow.md` 是本地工作流（官方 `change-workflow.md` 明确），不会被覆盖。
`SKILL.md` / `continue.md` 在 `.trellis/.template-hashes.json` 里有记录，
`trellis update` 可能提示冲突或恢复模板版本。

处置：新建 `.trellis/spec/guides/workflow-overrides.md`，记录
①改了哪几个文件 ②每个文件的判据锚点 ③一条自检命令：

```bash
grep -c "什么时候必须停下来问" .trellis/workflow.md \
  .claude/skills/trellis-brainstorm/SKILL.md \
  .claude/commands/trellis/continue.md
```

三个都 ≥1 说明覆盖还在；任何一个是 0，说明被 `trellis update` 冲掉了，按本文档恢复。

## 6. 不做什么

- **不删** Requirement Convergence Gate / PRD Convergence Pass / Evidence Rule
- **不删** Phase 2.2 check、Phase 3.3 spec、Phase 3.4 commit
- **不动** 全局红线的确认清单
- **不引入** 新的 config 开关 —— 判据写在文档里，比一个开关更难被误用

## 7. 回滚

五个文件都在 git 里，`git revert` 即可。没有代码路径依赖它们，
回滚后下一个会话立即恢复旧行为（hook 每轮重新读 `workflow.md`）。
