# 前端 / 控制台规范

Keel 当前有真实 Web 控制台，但**没有独立 React 组件体系、React Hooks、全局状态库或对应构建链**。不要用通用前端模板推断项目技术栈。

## 唯一现行控制台规范

- [Console Guidelines](./console-guidelines.md)：页面、数据投影、认证、人工操作、可观察性与真实测试门槛。
- 事实源：`src/cli/console.ts`、`src/cli/console-page.ts`、`src/cli/console-login-page.ts` 和 `src/cli/console.test.ts`。
- 为什么采用单一 WorkItem 投影： [ADR-0013](../../adr/0013-console-work-item-projection.md)。

如将来真的引入组件框架或状态库，先交付代码与测试，再补**对应实际行为**的规范；不提前创建空白文件。

本目录与 [后端规范](../backend/index.md) 一样，文档和注释用中文，API / 标识符用英文。
