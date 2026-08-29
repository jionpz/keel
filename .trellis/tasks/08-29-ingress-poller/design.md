# 接入自动化 Poller · 设计

## 进程模型

```
keel poller --repo <url> --interval 60s --label keel
  loop:
    gh issue list --label keel --state open
    for each not yet ingested:
      run-issue --ci real
    sleep interval
```

与 `timer-worker` 独立进程并列（见 `08-26-timer-worker-process`）。

## 幂等

ingest 已有 `UNIQUE(source, external_ref)`；poller 查 `task_feedback` 跳过已关联 Issue。

## 凭据

同验收：`KEEL_GITHUB_TOKEN` + 模型 key；poller 进程 env 注入。

## 不做什么

- 无 HTTP listener
- 无并发池（N4 仍保守）
