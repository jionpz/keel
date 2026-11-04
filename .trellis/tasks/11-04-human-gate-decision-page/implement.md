# 执行计划：人工闸门决策页

验证命令一律在仓库根执行。每个阶段结束都要能跑绿再进下一步。

## 0. 准备

- [ ] `python3 ./.trellis/scripts/task.py start 11-04-human-gate-decision-page`（状态 → in_progress）
- [ ] 开着一个停在闸门的任务：`pnpm run console` + 浏览器打开 `#task=5ec1ada9-…`（当前就在 `S-HUMAN_REVIEW`）
- [ ] 记下基线：现有四个 Tab 的内容与行为，改完后要逐字对得上（AC8）

## 1. 决策页骨架

- [ ] `renderDecisionTab(d)`：先渲染固定四块标题，内容暂用真实数据的最小版本
      （停住原因 / 证据 / 事实 / 选项）
- [ ] Tab 注入：`renderDetail` 里按 `status` 决定是否加入 `decision`，并设为默认激活；
      hash 里 `tab=overview` 等旧链接仍要能正常打开其它 Tab
- [ ] 概览 Tab 顶部保留一条窄入口（原 `human-callout` 位置）：「停在人工介入 · 去决策页」，不重复放按钮

验证：刷新页面，默认落在决策 Tab；把 hash 改成 `#task=…&tab=timeline` 仍进时间线。

## 2. 证据块（为什么是我）

- [ ] `decisionEvidence(d)`：纯函数，返回 `{ cause, trigger, attempts, retryExhausted }`
- [ ] 触发 Run 取「最后一条失败/超时」，展示 stage / attempt / status / error_kind / error_detail / 耗时
- [ ] `attempts`：同 `stage` 的全部 run，按 `attempt` 升序；`length > 1` 才渲染
- [ ] 已停留沿用 `data-since` + `tickElapsed`，不要另起定时器

验证：demo3（`5ec1ada9`）应显示 develop #3 TIMEOUT，轨迹 3 条。

## 3. 事实块（我在批准什么）

- [ ] `decisionFacts(d)`：分支、最新 RFC / policy 产物、diff 文件数、预算与已花
- [ ] 每个事实给一个跳转入口（切到「概览与方案」/「代码变更」Tab）
- [ ] 字段缺失整行不渲染

验证：demo3 显示 `ai/task-5ec1ada9 → main`、RFC v1 标题、预算与 $0.09。

## 4. 选项卡（选项即后果）

- [ ] `DECISION_OPTIONS` 常量表（文案 + 是否必填 + 是否可逆 + CTA）
- [ ] 卡片内联 `<textarea>`；必填为空时按钮 `disabled`
- [ ] 复用 `submitAction`，改造成「按卡片显示 busy / 成功 / 失败」
- [ ] 删除 `handleAct` 里的 `window.prompt(` 调用

验证：三个按钮文案与转移表一致；提交失败时错误显示在卡片内。

## 5. 澄清闸门

- [ ] `renderDecisionTab` 按状态分支：`S-NEED_CLARIFICATION` 渲染 PM 理由 / 原始需求 /
      `unresolved_questions`（有才渲染）/ TTL 剩余与超时后果
- [ ] 多行输入 + 「提交澄清」，走 `POST …/answer`

验证：临时把某个任务置为 `S-NEED_CLARIFICATION`（或用已有任务）确认渲染与提交。

## 6. 已发生的裁决

- [ ] `humanDecisions(events)`：`HumanDecision` 倒序，决定 / 理由 / 时间；空则不渲染

验证：跑一次 approve 再跑一次 rework 的任务能看到两条（可用 e2e 造的库，或临时造数后回滚）。

## 7. 样式与窄屏

- [ ] 决策页分块用发丝线，不堆卡片阴影；破坏性按钮唯一
- [ ] `≤1024px` 三张卡纵向排列、副作用文案在输入之前
- [ ] 无 emoji；机器码降为次要层级

验证：1440 / 1024 / 375 三个宽度截图。

## 8. 测试与收尾

- [ ] `console.test.ts` 新增：
  - 闸门状态的 HTML 含决策页骨架与三种副作用关键词；
  - 非闸门状态不含 `data-tab="decision"`；
  - 页面源码不含 `window.prompt(`；
  - `DECISION_OPTIONS` 的 key 集合 = `DECISIONS`（`decide.ts`）
- [ ] `pnpm run check` 全绿
- [ ] 更新 `spec/frontend/console-guidelines.md`（决策 Tab 与文案对齐纪律）
- [ ] 截图存档到任务目录 `shots/`（1440 / 1024）
- [ ] 提交（只 add 本任务文件）

## 回滚点

- 第 1 步之后：删除 `decision` Tab 注入即可回到现状
- 第 4 步之后：写端点未动，回退 `console-page.ts` 一个文件即可
