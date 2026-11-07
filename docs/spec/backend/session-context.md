# 上下文下行桥（Fact → Execution）

> 记录**实际**做法。来源：`08-26-v01-closeout` 任务第二轮验收抓出的**判据级**缺陷；
> 代码在 `src/execution/session/manager.ts`（`withPrompt`）与
> `src/execution/adapters/omp.ts`（`renderPrompt`）。

---

## Scope / Trigger

ContextBuilder 的产出（`RunSpec.context.sections`）是 Fact Plane 到达模型的
**唯一下行通道**。任何经手 `RunSpec` 的代码（SessionManager、Adapter、
未来的中间件）都受本契约约束。

为什么这是判据级而不是普通约定：

| | |
|---|---|
| 桥断了 | Fact Plane 的一切（反馈、RFC、状态）都没进模型 |
| `ContextBuilt` 事件是「Agent 当时到底看到了什么」的唯一答案（`O3`） | section 没进提示词 = 事件记的是**假话** |
| v0.1 判据要求「一条真实的用户反馈进入系统后……」 | 反馈从未进入执行侧，走完全程的是阶段指令模板自己 |

真实事故（2026-08-27）：`withPrompt` 曾**替换**整个 `sections`，
真实运行里 PM 如实回答「本次对话中不存在任何用户反馈原文」。
此前所有确定性测试与本地验收都是绿的 —— 阶段提示词自带暗示，模型照答即可通过；
整条链路上没有任何一处断言「ContextBuilder 造的东西真的到达了 Adapter」。

---

## 契约

### 1. SessionManager 只能**追加**，不能替换或丢弃

```ts
// src/execution/session/manager.ts
function withPrompt(spec: RunSpec, prompt: string): RunSpec {
  const sections = [...spec.context.sections, promptSection] // 原 section 在前
  return {
    ...spec,
    context: {
      ...spec.context,
      sections,
      total_tokens: sections.reduce((n, s) => n + s.tokens, 0), // 同步重算
    },
  }
}
```

- **追加在末尾**而非前插：阶段指令引用「上面的」内容，顺序是语义的一部分
- **`total_tokens` 必须同步重算**：记账与内容不一致会让预算判断建立在假数上
- 派生 section 的 `source_ref` 用 `derived:<来源>`（如 `derived:session-manager`），
  与 ContextBuilder 的 fact 引用可区分

### 2. Adapter 必须渲染**全部** section，且按序

```ts
// src/execution/adapters/omp.ts
function renderPrompt(spec: RunSpec): string {
  return spec.context.sections.map((s) => s.content).join('\n\n')
}
```

只取 `sections[0]`（或任何子集）都是违规 —— 模型实际收到的字节
必须与 `ContextBuilt` 事件记录的 section 一一对应。

---

## Wrong vs Correct

### Wrong（真实事故代码）

```ts
// 替换掉整个 sections —— role / feedback / rfc / state 全被丢弃
return { ...spec, context: { ...spec.context, sections: [promptSection] } }
```

```ts
// Adapter 只渲染第一个 section —— 其余 section 静默消失
function renderPrompt(spec: RunSpec): string {
  return spec.context.sections[0]?.content ?? ''
}
```

### Correct

原 section 在前、阶段指令在后、`total_tokens` 重算（见上「契约」）。

---

## 失败模式与对应测试锚点

| 失败模式 | 守它的测试 | 反例验证 |
|---|---|---|
| Manager 丢弃 ContextBuilder 的产出 | `src/e2e/session-pipeline.test.ts` ·「阶段指令是追加而非替换」 | 改回 `[promptSection]` → 红（`['prompt']` ≠ `['feedback','prompt']`） |
| Adapter 漏渲染 section | `src/execution/adapters/adapters.test.ts` ·「renderPrompt —— 每个 section 都要真的进提示词」 | 改成 `sections[0]?.content` → 红（marker 消失） |

后者用注入的 `spawnFn` 抓 omp 的 argv 末位（**模型实际收到的字节**），
不起进程、不花钱、进默认 `check`。

**改动任何经手 `RunSpec.context` 的代码时，这两条测试必须保持存在且通过。**
新增会转换 context 的层（如中间件）时，要为它加同样形状的「到达性」断言 ——
断言的对象永远是「模型实际收到什么」，不是「我以为传了什么」。

---

## 为什么强暗示的提示词掩盖了这个缺陷

阶段提示词里带着强暗示（如 PM 的「这是一个明确、范围很小的需求」），
模型照着暗示答即可让断言通过 —— 于是「模型看没看到上下文」从未被验证。

推论：**验收夹具的反馈必须是只有看到上下文才答得对的内容**
（参见 `v01-criterion-github.acceptance.test.ts` 的 FEEDBACK 注释），
且确定性测试必须直接断言到达的字节，不能只断言最终 verdict。
