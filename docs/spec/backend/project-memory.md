# 项目记忆、摘要与增量检索

> 范围：JT-03。项目仍是单 owner 下的 `repo`，`project_id` 使用 repo 的稳定 UUID。
> 原始 `managed_project_decision` 是唯一事实源；摘要是可重建、可回滚的读模型。

## 不变量

- 跨项目不共享候选。摘要、检索、日志、回滚和规则提升都同时携带并校验
  `project_id`；数据库外键也使用 `(id, project_id)` 组合约束，不只依赖应用层过滤。
- 摘要不能提升来源等级。`owner_confirmed`、`imported_candidate`、`policy_default`
  原样复制；重复引用、摘要生成和回滚都不会把推断变成用户确认。
- 摘要不会创造授权。天问只拿记忆作为上下文；确定性接纳器仍读取当前全部权威决定
  与委托策略自行裁决。
- 撤销、替代和输入变化立即增加 `managed_project_memory_state.epoch`，并写
  `managed_decision_change`。摘要记录构建时的 epoch 与变更水位，落后即视为 stale。
- 回滚只切摘要指针，不修改决定行，也不恢复旧授权。检索永远用当前权威决定覆盖摘要；
  已撤销/替代的决定即使存在于旧摘要中也不会返回。
- 关键约束无法在预算内完整重建时停止自动检索并升级，不静默截断。

## 数据模型

迁移：`migrations/1000000000017_project-memory.sql`。

| 表 | 作用 | 写入路径 |
|---|---|---|
| `managed_project_memory_state` | 每项目一个 epoch 与 ACTIVE 摘要指针 | 仅 SECURITY DEFINER 函数 |
| `managed_project_memory_summary` | 版本化 DRAFT/ACTIVE/SUPERSEDED/ROLLED_BACK/REJECTED 摘要 | `keel_control` 只能 INSERT；状态经函数切换 |
| `managed_project_memory_event` | 摘要创建/发布/拒绝/回滚、epoch、规则提升审计 | 控制入口 INSERT |
| `managed_project_memory_retrieval` | 每次检索的条件、候选、预算、扩展、引用与升级原因 | 控制入口 INSERT |

`managed_decision_change` 新增 `project_id`，用于按项目计算水位。决定插入、
委托策略插入、替代和撤销都会调用 `managed_project_memory_bump` 增加 epoch。

摘要内容由 `docs/schemas/managed/project-memory-content.schema.json` 定义，生成到
`src/generated/managed.ts`。每条条目包含 `project_id`、决定 ID/版本、完整选项、
作用域、来源等级、来源引用、有效期、派生条件与未决冲突。

## 摘要构建

`src/control/managed/memory-protocol.ts` 的 `buildProjectMemoryContent` 是纯函数：

1. 只纳入构建时刻仍有效的决定；
2. 按 `decision_key/version/id` 确定性排序；
3. 从 scope 与 `valid_until` 派生中文条件；
4. 同一 `decision_key` 的有效决定若答案不同，在双方写入冲突说明；
5. 超过 512 条返回 `CONTEXT_BUDGET_EXCEEDED`，不截断。

当前 v1 摘要构建器是确定性投影，`model_version` 记录
`keel-deterministic-v1`。未来若引入模型整理，模型输出仍必须经过同一 schema、
权威决定逐条比对与发布校验，不能直接写 `content`。

`createProjectMemorySummary` 先调用 `managed_project_memory_lock` 锁住当前 epoch，
再读取决定、水位与版本号并写入 DRAFT。这样构建期间发生的新决定会等待提交，
不会产生“读到一半 epoch”的摘要。

## 发布与回滚

发布前必须通过：

- schema、`project_id`、决定 ID/版本与字段快照校验；
- `content_digest` 重算；
- 用发布时刻的当前有效决定重建，摘要 digest 必须完全一致；
- 可选回归问题集：每个 case 的 `expected_decision_ids` 必须被检索到。

任一失败保持上一 ACTIVE 摘要不变。成功由
`managed_publish_memory_summary` 在同一事务内：

1. CAS 当前 epoch；
2. 旧 ACTIVE 标为 `SUPERSEDED`；
3. 新 DRAFT 标为 `ACTIVE` 并保存 `validation`；
4. 原子切换 state 指针并写事件。

回滚要求调用方持有当前 epoch，只允许曾发布过的摘要。它把当前摘要标为
`ROLLED_BACK`、目标摘要恢复 ACTIVE，并写 `rollback_of_summary_id` 与审计事件。
目标摘要可以来自旧 epoch，因此检索必须继续执行下面的权威覆盖。

## 检索

`retrieveProjectMemory` 默认最多 8 条、4000 tokens；上限分别为 64 条和 32000 tokens。
检索步骤：

1. 严格按 `project_id` 读取 state 与 ACTIVE 摘要；
2. 校验摘要 schema、digest 与项目标识；
3. 只要 epoch 落后、水位落后或引用决定已失效，摘要就标记 stale；
4. 按摘要引用 ID 回查当前决定，用当前条目覆盖旧摘要条目；
5. 对精确 `decision_key` 或文本命中的活跃决定做增量查询；
6. 合并后按精确 key、文本命中、作用域适用性排序；
7. 关键候选装不下预算时返回 `escalation_reason`，不返回部分关键集合；
8. 非关键候选省略时记录 `omitted_count` 与 `expansion_reason`；
9. 检索结束前再次读取 epoch 与水位；发生变化则返回 `CONFLICT` 并重试一次。

每次检索写 `managed_project_memory_retrieval`，包括查询条件、摘要版本、stale、
epoch、候选数、是否扩展、扩展/升级原因、实际引用决定、预算和实际使用量。

当前检索是项目内关键词/子串匹配，不引入向量库。中文查询按 Han bigram 扩展；
精确 `decision_key` 是最强匹配信号。

## 人工答案提升

`promoteHumanAnswerToProjectRule` 只接受：

- 已结束请求（`RESOLVED`）；
- `human_confirmed` 决议；
- `actor.type = human` 且带认证 ID；
- 答案精确来自请求选项。

它创建新的 `ProjectDecision`，`source_type = owner_confirmed`，`source_ref` 指向
`managed-decision-resolution:<request>:<revision>`，scope 默认来自该请求的
kind/action/resources/environment/reversibility。天问的 `delegated` 决议或伪造 actor
会被拒绝。

当前认证边界是本机单 owner：CLI 使用 `local-operator`。Keel 定位为个人单用户
工具，不使用多租户身份认证；该入口只服务本机 owner。

## CLI

```text
keel managed memory-status PROJECT_UUID
keel managed memory-summary PROJECT_UUID --generated-by local-operator
keel managed memory-publish SUMMARY_UUID --project PROJECT_UUID --epoch N [--regression FILE]
keel managed memory-reject SUMMARY_UUID --project PROJECT_UUID [--reason TEXT]
keel managed memory-rollback SUMMARY_UUID --project PROJECT_UUID --epoch N --reason TEXT
keel managed memory-retrieve PROJECT_UUID --query TEXT [--key DECISION_KEY] [--request UUID]
keel managed memory-promote REQUEST_UUID --revision N --key DECISION_KEY
```

回归文件格式：

```json
{
  "cases": [
    {
      "query": "报告使用哪种语言",
      "decision_key": "report.language",
      "expected_decision_ids": ["<uuid>"]
    }
  ]
}
```

## 权限

- `keel_control` 对 state 只读；对 summary/event/retrieval 只 INSERT；
- 发布、回滚、拒绝与 epoch 锁只能经 SECURITY DEFINER 函数；
- `keel_execution` 和 `keel_ingress` 对四张记忆表没有权限；
- 记忆不进入日志正文，检索日志只保存结构化条件、ID 与预算元数据。

## 已知限制

- 不做跨项目偏好、全局用户记忆或多租户；
- 不引入向量库、消息中间件或模型训练；
- 摘要不自动定时重建；由控制入口触发；
- 本地关键词检索不等于语义检索，模糊问题仍可能升级人工；
- 检索预算按 JSON 字符数估算 token，是保守近似而非真实 tokenizer。
