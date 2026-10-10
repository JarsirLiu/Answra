# 仓库协作规范（AGENTS.md）

面向人类协作者与 AI 助手的仓库结构与架构约定。参照 ZCode 的 monorepo 标准维护，目标是支持团队长期迭代，而非一次性原型。

## 包结构与依赖方向

```text
@exam-assistant/shared  ←  @exam-assistant/ui  ←  @exam-assistant/desktop(renderer)
                                    ↑
@exam-assistant/shared  ←  @exam-assistant/desktop(main / preload)
```

- 依赖必须单向，禁止环（`pnpm architecture:check` 强制）。
- 跨包导入只允许使用目标包 `package.json` `exports` 声明的入口；禁止深导入、禁止相对路径跨包（架构脚本强制）。
- 新增共享能力时：类型/常量进 `shared`，纯 UI 进 `ui`，平台能力进 `desktop`。

## 进程边界（apps/desktop）

| 目录 | 职责 | 约束 |
| --- | --- | --- |
| `src/main` | 窗口管理、生命周期、按领域拆分的 IPC handler（`src/main/ipc/*Ipc.ts`） | 可用 electron / node 内置模块 |
| `src/preload` | `contextBridge` 暴露唯一 `window.examAssistant` API 面 | 只做转发，不放业务逻辑 |
| `src/renderer` | 薄壳：挂载 `<FloatingBarApp/>` | 禁止 import electron / node 模块 |

## IPC 约定（三层类型安全）

1. 频道常量与请求/响应类型映射只写在 `packages/shared/src/channels.ts`，命名 `exam-assistant:<域>:<动作>`。
2. main 侧 handler 按领域一个文件，注册前用 `isWindowFromSender` 校验来源。
3. preload 消费 ChannelMap 类型；renderer 通过 `DesktopBridge` 接口访问，测试注入 mock bridge。

## 环境变量

- 变量名只允许在 `packages/shared/src/env.ts` 定义一次；`.env.example` 逐项注明用途与是否 secret。
- 运行时读取统一走类型化函数（如 `parseExamAssistantEnv`），禁止散落 `process.env.XXX`。

## 质量门禁

- `pnpm verify` = biome lint + 全包 typecheck + vitest + 架构守护；husky pre-push 自动执行。
- 每个 UI 行为变化在 `packages/ui/test/` 补测试；main 进程逻辑后续用 node:test/vitest 覆盖。
- 提交信息使用 Conventional Commits，标题简明。

## 文档

- 交互决策记录在 `docs/`（如 `FLOATING-BAR-INTERACTION.md`）；结构性变更同步本文件与 README 的仓库结构表。
