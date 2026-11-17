# PR 标题与正文

> 范围：`#135`。legacy Task/Run 的 `CreatePullRequest` 副作用与 managed ticket 的
> `land` action intent 共用同一套描述生成规则；事实来源是已落库的产物与阶段记录，
> 不在开 PR 时重新向模型要事实。实现见 `src/control/pr-description.ts`。

## 1. 标题

| 条件 | 标题 |
|---|---|
| 仓库未配置 `commit_message_template` | 来源 issue / ticket 标题（单行化、去掉首尾空白） |
| 配置模板，且 develop 产物或 HEAD commit 能解析出模板字段 | 按同一模板渲染 header |
| 配置模板，但字段缺失或不合法 | 退回来源标题，不把不合规标题送到 GitHub |

模板字段来自已落库事实，不从 `land` 阶段的模型自报标题重新生成：

- legacy：最新未取代的 `stage_outcome/develop` 产物里的 `commit_message`；
- managed：land 时真实 HEAD commit 的 header，按仓库模板解析。

渲染时先压缩字段空白，再截断到 100 个 Unicode 字符；`commit_message_check` 是正则时，
最终标题还必须匹配该正则，否则退回来源标题。`hook` 无法在标题阶段执行，只按模板校验。
标题不追加 `Keel-Run:` 行。

## 2. 正文

正文以固定兼容行 `Keel Task <task id>` 开头，随后按章节渲染：

| 章节 | 事实来源 | 缺失时 |
|---|---|---|
| 问题 | 来源 issue / ticket 标题 | 不退场：来源标题始终存在 |
| 根因 | legacy `A-RFC.problem` | 整节省略 |
| 改动 | `A-RFC.proposed_change` + `stage_outcome/develop.reason` | 退回分支与基线事实 |
| 验证 | `stage_outcome/qa` / `stage_outcome/review` 的 verdict 与 reason | 整节省略 |
| 风险与未做 | `A-State.risks`、Review `verdict=fail` 的 failed criteria | 整节省略 |

每个章节末尾写 `来源：<ref>`，可回查 Fact Plane：

- RFC / State：`artifact:rfc@<version>`、`artifact:state@<version>`；
- 阶段产物：`artifact:stage_outcome/<key>@<version>`；
- managed：`managed-ticket:<ticket id>`、`managed-ticket-stage:<stage>:<stage row id>`。

缺失产物只省略对应章节，不写“无”“待补充”等占位文字。正文主体超过上限时先截断
主体，再追加 issue 引用与机器标记，避免截掉 `Closes` / `keel:v1`。

## 3. 兼容契约

以下内容保持不变：

- 首行 `Keel Task <task id>`；
- 同仓 issue 写 `Closes #n`，跨仓写 `Refs owner/repo#n`；
- 末尾 `<!-- keel:v1 task=<task id> -->` 机器标记。

managed 的 `land` 仍只登记 action intent；标题与正文由 Keel 从事实生成，
gateway 只负责受控 push 与创建 PR。

## 4. 测试锚点

- `control/pr-description.test.ts`：标题模板、压缩截断、header 正则、章节取舍、
  来源标识与兼容标记；
- `control/driver/effects.test.ts`：legacy 从 RFC/State/develop/QA/Review 产物生成正文，
  以及配置模板后的真实标题；
- `control/managed/ticket-runtime.test.ts`：managed 从阶段记录生成正文与标题。
