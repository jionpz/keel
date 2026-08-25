# Round 2 P2 行为正确性组

## Goal

修复 issue #23 报告的 6 项 P2 行为缺陷。全部是「能跑但语义/边界不正确」,非架构一致性(后者另组)。

## Requirements

### R5 · brainstorm↔critic 活锁无收敛保护

**现状**:模型连续 `needs_critic=true` 时,每轮 brainstorm→critic 耗 2 步,T-009/T-009b 都是 SELF+nextRun,循环至 maxSteps(20) 以 RUN_TIMEOUT 中止。
**修**:critic 最多请求 2 次;第 2 次回流后强制走 T-010(不再接受 needs_critic)。
- 判定:`(task_id, stage='critic')` 的 run 数 ≥ 2 时,brainstormNeedsCritic 返回 false(强制收敛)。
- 位置:`src/control/orchestrator/loop.ts` brainstormNeedsCritic。

### R3 · capability 裁决链对合成路径装饰性

**现状**:loop 硬编码 `capability:'critic_review'`(合成 + 事件),P-ALLOW-CRITIC 恒真;validate step-4 的 capability_request 分支无触发源。
**修**:从 brainstorm 产物 `details.capability` 按键确判(capability 来自模型声明,不是硬编码);保留 deny 可能(T-009 guard 用该值求值)。
- 位置:`loop.ts` synthesizeCapabilityRequest + CapabilityRequested 事件;`prompts.ts` brainstorm 提示词加 `details.capability` 字段说明。
- **关键**:capability 值不再写死 —— 若模型 `details.capability='other'` → P-ALLOW-CRITIC 不命中 → 默认 deny → guard 不过 → 停(等人工),保留拒绝留痕。

### R4 · 编排器把 guard 未过(matched:false)当成功

**现状**:capability 被拒时 driver.advance 返回 ok{advanced:false}(NoTransition 已落库),loop `if(!adv.ok)` 不拦截 → 记录后 continue → 无 PENDING → ok 收尾,误报成功。
**修**:loop 对 CapabilityRequested 的 advance 检查 `adv.value.advanced`;false → **停**(返回当前状态,能力被拒 = 需要人工/外部,不假装成功)。NoTransition 事件已是诚实留痕。
- 位置:`loop.ts` brainstorm 分支。

### R9 · FAILED → PROTOCOL_ERROR 标签语义不符

**现状**:`RUN_STATUS_ERROR.FAILED='PROTOCOL_ERROR'` —— FAILED(运行失败)被压平成「协议错误」,retryable 归因误导。
**修**:文档真相化 —— RUN_STATUS_ERROR 注释说明 FAILED 映射 PROTOCOL_ERROR 的取舍(Adapter 的 FAILED 不含详细分类,PROTOCOL_ERROR 是可重试失败的通配);不引入新 ErrorKind(改动面大)。补充:Adapter 契约明确 FAILED 的语义(运行终止但顺序执行,与 TIMEOUT 区分)。
- 位置:`manager.ts` 注释 + `harness-adapter.ts` RunResult.status 注释。

### R8 · git-diff change 分类与 porcelain 语义分叉

**现状**:porcelain 首两字符 `XY`(X=暂存区,Y=工作区);实现 `code.includes('D')` 对 `AD`(暂存新增+工作区删除)等误分类。
**修**:按第二列(工作区状态)优先分类——`Y` 列决定变更类型;仅当 XY 双 D 才 deleted;`?`/`!` 未跟踪=added。
- 位置:`git-diff.ts` 分类逻辑 + 回归测试补 `AD`/`MM` 用例。

### R7 · OMP interrupt 无 SIGKILL 兜底,spawn 未建进程组

**现状**:interrupt 只 SIGTERM,无超时后 SIGKILL;spawn 未 detached 建进程组,omp 子进程可能逃逸。
**修**:interrupt 发 SIGTERM 后设超时(如 2s)再 SIGKILL;spawn 用 `detached:true` 建进程组,先 `process.kill(-pid)`(组)后单进程。
- 位置:`omp.ts` interrupt + run() 的 spawn options。

## Acceptance Criteria

- [ ] R5:critic 请求 ≥2 次后强制收敛(第 2 回流走 T-010);e2e 断言不会无限循环
- [ ] R3:capability 来自 details.capability;值非 critic_review 时被拒(停,留 NoTransition);P-ALLOW-CRITIC 不再是恒真路径
- [ ] R4:capability 被拒时 loop 停(不 ok 收尾);e2e 断言
- [ ] R9:`RUN_STATUS_ERROR` 注释 + RunResult.status 文档更新;无代码行为变化(纯文档)
- [ ] R8:git-diff 分类按工作区列;AD/MM 回归通过
- [ ] R7:interrupt 超时 SIGKILL;spawn detached;fixture 测试(组 kill 语义)
- [ ] `pnpm run check` 全绿

## Constraints

- 不改 ActionStrictness/P-ALLOW-CRITIC 规则集(deny 语义不变)。
- 不引入新 ErrorKind(R9 用文档取舍)。
- 不实现 durable timer(活锁上限用同步轮次计数,非定时器)。
- R5 的「≥2 次强制收敛」是硬上限,不依赖模型自控。

## Notes

- 复杂任务:需 design.md + implement.md 后 start。
- 关联:critic-path.test.ts(现有)e2e 需适配 R3/R5(capability 来源变化、轮次上限)。
- R4 与 R3 联动:capability 拒 → advance advanced:false → loop 停。