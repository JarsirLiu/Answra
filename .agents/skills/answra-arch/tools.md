# 工具执行

本文件回答：工具在哪执行、谁授权、边界在哪、输出怎么回传。

## 执行位置

全部在 agent 进程执行。desktop 只注入 `workspaceRoot` 等授权上下文，不代执行工具，也不通过反向 RPC 提供工具能力；唯一反向请求是云端 token 刷新。

## 授权

- 声明式 `ToolId[]`：领域 profile/policy 是唯一来源。
- `ToolRegistry.authorize` 遇到未注册 ID 直接 throw（fail-fast），不静默裁剪。
- 授权缺省即无：没有写进 policy 的工具对模型不可见。

## 内置工具

| ToolId | 作用 |
| --- | --- |
| `workspace.read` | 读文件（含 docx/pdf 文本提取） |
| `workspace.grep` | 检索（ripgrep worker） |
| `workspace.edit` | 精确替换写入（多 hunk、原子写） |
| `workspace.run-command` | 一次性命令与常驻 shell 会话（LRU） |
| `skill.load` | 按名加载 skill（不接受模型传入路径） |

## 执行链

`ToolRegistry` → `executeToolCall`（超时、abort、结果预算）→ 工具实现 → `tool-result` / `tool-error`。

- **请求循环目标架构**：Session/Turn/Step 拥有权威边界后，Turn 内循环由 `core/session/turnExecutor.ts` 持有；每个 Step 只对应一次模型响应。`ProviderStepRunner` 请求一次后由项目执行该响应的工具调用，TurnExecutor 再决定是否创建下一 Step。AI SDK `streamText` 只收到 schema-only 工具定义，不得持有本地 `execute` 并自动继续请求。工具授权仍只来自声明式 `ToolId[]`，执行仍复用 `ToolRegistry` 与 `executeToolCall`。
- **当前实现**：`ProviderStepRunner` 将授权 ToolSet 投影为无 `execute` 的 schema-only 声明，单个 AI SDK `streamText` 因而在 tool-call 响应处结束；随后项目按响应顺序调用原授权工具闭包并记录执行事实。`prepareStep` 已在请求前按项目 Step index 执行，不再交给 SDK。`MAX_TOOL_STEPS = 20` 在第 20 个工具 Step 后强制文本收尾。Turn 中活动的 streaming assistant 消息会投影到下一 Step，保留前一 Step 的 tool-call/result；context overflow 压缩成功时由 TurnExecutor 创建新 Step 继续。此处由 mock-model 与纯函数测试验证；真实兼容端点历史格式仍未验证，详见 [逐次请求 Note](../../../docs/notes/proposed/architecture/2026-11-24-project-controlled-model-request-loop.md)。
- `run-command` 维护 shell 会话，agent 收尾统一释放；进程树按平台收敛。
- 输出增量走 live 中继（有界）；终态走 durable 的 `tool-result` / `tool-error`。

## 反面清单

- 不要让 desktop 代执行工具或提供"万能 RPC"。
- 不要用 renderer 传入的 prompt/工具覆盖静态注册。
- 不要在 UI 里解析工具输出；用 `@answra/ui/tool-presentation`。

相关：`events.md`（工具事实）、`projection.md`（工具展示）。
