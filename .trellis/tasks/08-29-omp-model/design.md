# OMP 模型可配 · 设计

## 数据流

```
--model | KEEL_MODEL | default
  → resolveModel(cli, env)
  → runTask({ model })
  → new OmpAdapter({ model })
  → buildArgv(spec, model)  // 已有
```

`resolveModel` 放在 `run-task.ts`（与 `parseCiMode` 同层），`run-issue` 只透传。

## 优先级

1. `--model` 有值且非空白
2. `process.env.KEEL_MODEL` 非空白
3. `'deepseek-v4-flash'`

## 错误

空白 CLI/env：`CAPABILITY_UNSUPPORTED`，detail 写明「空白模型会静默回退缺省，拒绝」。

## 测试

- `run-task.test.ts`：解析函数（抽纯函数便于测，不启 omp）
- 已有 `buildArgv` 测试补一条自定义 model
- `run-issue.test.ts`：若有组装测试则钉住透传
