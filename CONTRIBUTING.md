# 贡献指南

## 本地开发流程

1. 使用 Corepack 安装仓库指定版本的 pnpm，然后执行 `pnpm install`。
2. 从 `main` 创建一个目标明确的分支。
3. 完成范围尽可能小且完整的改动，并为用户可见行为添加测试。
4. 运行 `pnpm lint`、`pnpm typecheck`、`pnpm test` 和 `pnpm build`。
5. 提交 Pull Request，说明行为变化、验证结果；界面变化附上截图。

## 工程约定

- Electron 原生能力放在主进程，通过 preload 暴露最小必要接口。
- 把 renderer 输入和 IPC 消息视为不可信数据，并在主进程校验。
- 模型供应商和网络访问通过应用接口隔离；renderer 不保存 API 密钥。
- 在界面上如实区分演示、不可用和等待权限的功能。
- 只有存在独立消费者时才新增 workspace package，避免提前拆分。

## Pull Request 要求

Pull Request 应说明用户可见的变化、已运行的检查和平台限制。涉及布局或交互时附上截图。合并前 CI 必须通过。
