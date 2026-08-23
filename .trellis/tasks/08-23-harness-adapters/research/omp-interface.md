# Research · Oh My Pi (OMP) 接口 —— 实测

> 任务：`.trellis/tasks/08-23-harness-adapters`
> 日期：2026-08-23
> 方式：**本机实测**（omp v17.4.2，模型 `deepseek-v4-flash`），非文档推断。

---

## 背景：这条调研推翻了之前的两个结论

`research/harness-interfaces.md` 因推理网关限流，把 OMP 标为 `未验证`；
`ADR-0005` 据此把 OMP **移出 v0.1 首批支持范围**，理由是
「在无法查证其接口的情况下，任何 Adapter 设计都是虚构」。

现在有了本机实测数据。两个结论都要改，见 §5。

---

## 1. 非交互入口 ✅

```bash
omp -p --mode=json --model deepseek-v4-flash \
    --no-extensions --no-skills --no-rules --no-tools \
    "<prompt>" < /dev/null
```

- `-p` / `--print`：非交互，处理完退出
- 退出码：成功 `0`；错误（如 session 不存在）`1` —— **实测确认**
- `--cwd=<value>` 指定工作目录；`--add-dir` 追加

### ⚠️ 必须消费完整个输出流

**实测踩到的坑**：用 `| head -1` 只取首行拿 session id，会让 omp 收到 SIGPIPE
而在**写入会话文件之前就死掉** —— 于是后续 `--resume` 报 "Session not found"。

排查过程：前两次 resume 均失败，第三次改为先重定向到文件、再解析，resume 立刻成功。

→ **对 Adapter 的硬要求**：必须读完整个 stdout 再处理，不得提前关闭管道。

---

## 2. 结构化输出 ✅ NDJSON 事件流

`--mode=<value>`：`text`（默认）| `json` | `rpc` | `rpc-ui`

`--mode=json` 输出 newline-delimited JSON。实测到的事件类型：

| `type` | 关键字段 |
|---|---|
| `session` | **`id`**（resume 句柄）、`version`、`timestamp`、`cwd` |
| `agent_start` | — |
| `turn_start` | — |
| `message_start` / `message_end` | `message.role`、`message.content[]`、`message.usage` |
| `message_update` | `assistantMessageEvent`：`text_start` / `text_delta` / `text_end` |
| `turn_end` | `message`、`toolResults[]` |
| `agent_end` | `messages[]`、`isTerminal` |

**首行即 `session` 事件，`id` 就在里面** —— Adapter 可在第一行拿到 resume 句柄。

### content block 有多种类型

实测 deepseek 返回：`[('thinking', ''), ('text', '4271')]`。

→ **Adapter 不能假设 `content[0].type === 'text'`**，必须遍历并按类型处理。
（第一版解析脚本正是因为这个假设而崩溃。）

---

## 3. 会话恢复 ✅ 实测通过

```bash
omp -p --mode=json --resume "<session-id>" "<prompt>"
```

**验证方式**：第一轮让它记住数字 `4271`，第二轮 `--resume` 后问「刚才让你记的数字是多少」，
**回答 `4271`** —— 上下文确实被恢复。

会话文件落在 `~/.omp/agent/sessions/<cwd 编码>/<时间戳>_<session-id>.jsonl`。
`--session-dir` 可指定目录（但注意 §1 的 SIGPIPE 坑：流没消费完就不会写）。

### 恢复的成本收益是数量级的

| | `input` tokens |
|---|---|
| 首轮（全量上下文） | 39,651 |
| `--resume` 后 | **208** |

→ 这直接量化了 `docs/05-contracts/harness-adapter.md` §2 的主张
「无 `CAP-RESUME` 只是更贵」—— 贵约**两个数量级**。

---

## 4. 成本上报 ✅ 且是**算好的金额**

`message.usage`：

```json
{"input":39651,"output":3,"cacheRead":0,"cacheWrite":0,"totalTokens":39654,
 "cost":{"input":0.00555114,"output":8.4e-7,"cacheRead":0,"cacheWrite":0,"total":0.00555198}}
```

有 `cost.total`（美元），并区分 `cacheRead` / `cacheWrite`。

> ⚠️ **口径未确认**：文档未说明这是 `billed` 还是 `estimated`。
> 在确认前，Adapter 按 `estimated` 上报 —— 与 Claude Code 一致，宁可保守。

---

## 5. 权限与隔离

| 开关 | 作用 |
|---|---|
| `--no-tools` | 禁用全部内置工具 |
| `--tools=<list>` | 白名单 |
| `--approval-mode=<always-ask\|write\|yolo>` | 审批模式 |
| `--auto-approve` | 自动批准全部工具调用 |
| `--no-pty` | 禁用 PTY 交互式 bash |

### `CAP-UNTRUSTED_WORKSPACE` 的落点

| 开关 | 挡住什么 |
|---|---|
| `--no-extensions` | 不加载扩展发现（`-e` 显式路径仍生效） |
| `--no-skills` | 不加载 skills |
| `--no-rules` | 不加载 rules |
| `--profile=<name>` | 隔离 auth / sessions / settings / caches |

这组等价于 Claude Code 的 `--bare`。

> ⚠️ **未验证**：没有实测「仓库里放一个恶意扩展，加与不加 `--no-extensions` 的差别」。
> 上表是**依据 `--help` 的描述**推断的。接入前应补这个反例测试 ——
> 本项目的纪律是「未经反例验证的约束等同于没有约束」。

---

## 6. 其他值得记的

| 项 | 说明 |
|---|---|
| `--model` | 模糊匹配（`opus` / `gpt-5.2` / `openai/gpt-5.2`）→ `CAP-MODEL_OVERRIDE` 成立 |
| `--max-time=<10m\|1h>` | 墙钟上限，可直接映射 `RunSpec.limits.wall_clock_s` |
| `--no-session` | 临时会话，不落盘 |
| `acp` 子命令 | 可作为 ACP server 跑在 stdio 上 —— 另一条集成路径，v0.1 不用 |
| 可用模型 | 本机 provider `cpa` / `zen` 均有 `deepseek-v4-flash`（1M 上下文） |

---

## 7. 能力小结

| Capability | OMP | 依据 |
|---|---|---|
| `CAP-HEADLESS` | ✅ | `-p`，实测 |
| `CAP-STREAM` | ✅ | `--mode=json` NDJSON，实测 |
| `CAP-RESUME` | ✅ | `--resume`，**实测恢复了上下文** |
| `CAP-COST` | ✅ | `usage.cost.total`，实测 |
| `CAP-PERMISSION` | ✅ | `--tools` / `--approval-mode` |
| `CAP-UNTRUSTED_WORKSPACE` | 🟡 | 开关存在，**隔离效果未做反例验证** |
| `CAP-MODEL_OVERRIDE` | ✅ | `--model` |
| `CAP-INTERRUPT` | 🟡 | 未测；`--max-time` 可作超时兜底 |
| **`CAP-STRUCTURED_OUTPUT`** | ❌ | **`--help` 中没有 schema 约束类开关** |

---

## 8. ⚠️ 本次调研推翻的设计：L0/L1/L2 线性分级

`docs/05-contracts/harness-adapter.md` §1.2 定义：

```
L0 = CAP-HEADLESS
L1 = L0 + CAP-RESUME + CAP-STRUCTURED_OUTPUT
L2 = L1 + CAP-STREAM + CAP-COST + CAP-PERMISSION
```

**OMP 具备 RESUME / STREAM / COST / PERMISSION，唯独没有 STRUCTURED_OUTPUT。**
按上述定义，它连 L1 都够不上，只能标 `L0` ——
而 `L0` 在降级矩阵里意味着「每轮从 Artifact 重新物化上下文」，
这对一个**实测 resume 有效、且省两个数量级 token** 的 harness 是完全错误的描述。

### 根因

线性阶梯假设了能力是**嵌套**的，但它们其实是**正交**的。
这个假设在只有一个 harness（Claude Code，恰好全都有）时不会暴露；
接入第二个就立刻塌了。

> `ADR-0005` 当时写过：「首批只有一个真实 AI harness，
> 『可替换』这一主张在 v0.1 **未被充分证伪**。
> 第二个 AI harness 接入是阶段二的首要验证目标。」
>
> 现在证伪发生了，而且比预期早。

### 建议的修正

把 `CAP-STRUCTURED_OUTPUT` 与 `CAP-PERMISSION` **移出阶梯**，
与 `CAP-UNTRUSTED_WORKSPACE` 一样作为独立能力：

```
L0 = CAP-HEADLESS                      每条降级路径全开
L1 = L0 + CAP-RESUME                   会话可恢复（最大的 token 杠杆）
L2 = L1 + CAP-STREAM + CAP-COST        中途可观测、可按预算熔断
```

于是：**Claude Code = L2、OMP = L2**，两者的差别体现在各自的
capability 集合而非档次上。**降级矩阵本来就是按能力逐条的**，
阶梯只是人看的摘要 —— 它不该参与决策。

---

## 9. 对 ADR-0005 的影响

原文把 OMP 移出 v0.1 首批，理由是接口无法查证。**该理由已不成立。**

建议：OMP 进入 v0.1 首批，与 Claude Code 并列。这带来一个额外好处 ——
`ADR-0005` 曾担心「首批只有一个真实 AI harness，可替换性未被验证」，
两个真实 harness 才能真正检验 Adapter 契约。

TRAE 仍无本机可验证的实例，**保持 `未验证` 并留在首批之外**。
