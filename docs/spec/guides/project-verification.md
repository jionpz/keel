# 注册项目验证

为每项必要检查选择一个稳定的 `id`。`paths` 使用 Git 仓库相对路径，可写目录或
文件。省略 `paths` 或使用 `.` 表示全仓适用。每个改动路径都需要被至少一项
检查覆盖。一个路径匹配多个检查时，Keel 要求每项都通过。

在管理员控制的目录保存 `verification.json`。以下示例运行 Node 自带测试工具与
pytest，并要求 GitHub 报告名为 `Backend CI` 的检查。

```json
{
  "version": "1",
  "checks": [
    {
      "id": "frontend",
      "kind": "local",
      "paths": ["frontend"],
      "argv": ["node", "--test", "frontend/guard.test.mjs"]
    },
    {
      "id": "backend",
      "kind": "local",
      "paths": ["backend"],
      "argv": [
        "/bin/sh",
        "-c",
        "PYTHONDONTWRITEBYTECODE=1 exec /opt/homebrew/bin/python3 -m pytest -p no:cacheprovider --basetemp=\"$TMPDIR/pytest\" backend"
      ]
    },
    {
      "id": "backend-ci",
      "kind": "remote",
      "paths": ["backend", ".github/workflows/ci.yml"],
      "name": "Backend CI"
    }
  ]
}
```

按项目实际改动范围补充共享配置、锁文件和根目录规则的检查覆盖。使用 CI 报告
的完整检查名称。没有提交 PR 的交付目标无法满足适用的远端检查。

```bash
keel register-repo https://github.com/you/project \
  --local-path "$HOME/code/project" \
  --verification-contract "$HOME/keel-config/verification.json"
```

配置写入仓库注册。更新时重新注册，省略该参数会保留已注册的配置。已有
managed workflow 可以在节点开工前通过 `keel managed workflow-plan --replan` 重新绑定。

## 在只读检出中运行测试

在执行主机上预装工具与依赖，并确保运行时位于沙箱可读目录。示例中的 Python
需要能直接导入 pytest 和项目依赖。Keel 从准确提交建立干净的只读检出。
原工作树的 `node_modules`、虚拟环境和其他未跟踪文件不会进入检出。
检查只能使用隔离的 `HOME` 和 `TMPDIR` 写入缓存与临时文件。本地命令使用
macOS 的操作系统沙箱，检查进程没有宿主凭据或 TCP 网络访问。

pytest 示例用 `PYTHONDONTWRITEBYTECODE=1` 避免写 `__pycache__`，用
`-p no:cacheprovider` 关闭 `.pytest_cache`，并把 `tmp_path` 等临时文件放在
`$TMPDIR/pytest`。Keel 默认按 argv 直接启动可执行文件。示例中的 `/bin/sh -c`
由管理员显式注册，负责展开 `$TMPDIR`。

使用 Vitest 时，在可读位置预装 Vitest 并确保测试能解析依赖。对支持
`--configLoader runner` 的版本，可用 `vitest run --configLoader runner --no-cache
frontend/guard.test.js`。Vite 配置可将 `cacheDir` 设为
`join(process.env.TMPDIR, 'vite')`。需要写构建文件或覆盖率报告的工具也应将
输出目录配置到 `TMPDIR`。
