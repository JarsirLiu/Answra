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

- 工具调用步数上限 `MAX_TOOL_STEPS = 20`（`core/agent/toolStepLimit.ts`）；到限后强制 `toolChoice: "none"` 并追加收尾提示。
- `run-command` 维护 shell 会话，agent 收尾统一释放；进程树按平台收敛。
- 输出增量走 live 中继（有界）；终态走 durable 的 `tool-result` / `tool-error`。

## 反面清单

- 不要让 desktop 代执行工具或提供"万能 RPC"。
- 不要用 renderer 传入的 prompt/工具覆盖静态注册。
- 不要在 UI 里解析工具输出；用 `@answra/ui/tool-presentation`。

相关：`events.md`（工具事实）、`projection.md`（工具展示）。
