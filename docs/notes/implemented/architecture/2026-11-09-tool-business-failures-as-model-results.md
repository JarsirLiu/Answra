# Note：工具业务失败改为模型可见结果

状态：已实施

## 问题

`ToolRegistry` 把 `executeToolCall` 返回的 `ToolFailure` 重新抛成 `ToolExecutionError`。AI SDK 会把 `execute` 抛出的错误记为 `tool-error`，而用户要求工具执行失败不能表现为“工具执行错误”。对文件不存在、非法参数、超时等业务结果，模型应像接收普通工具结果一样看到失败原因并自行纠正；只有真正的进程/基础设施异常才应中断工具调用。

## 涉及范围

- `apps/agent/src/core/tool/contracts.ts`：`ToolFailure` 增加 `modelContent`。
- `apps/agent/src/core/tool/executor/result.ts`：`toFailure` 生成模型可见失败文本。
- `apps/agent/src/core/tool/registry.ts`：不再对 `ToolFailure` 抛 `ToolExecutionError`，直接返回 `modelContent`。
- `apps/agent/test/core/tool/registry.test.ts`、`executeToolCall.test.ts`：失败结果文本与不抛出行为。
- UI/进程/协议/持久化表面：不新增事件类型；AI SDK 仍按成功的工具结果产生 `tool-result` 与 `tool-execution-finished`。
- 相关 Note：`2026-11-09-agent-tool-system-foundation.md`。

## 模块边界

- `executeToolCall` 继续负责单次调用的校验、归一化、超时、取消和结果预算，并区分业务失败与基础设施错误。
- `registry` 只负责把 `ToolResult` 投影成 AI SDK 的模型结果，不决定业务错误码，也不写工具事件。
- `core/agent/executeRun.ts` 仍是工具执行事件的唯一写入点；本次不引入第二套事件或状态。

## 决定

- `ToolFailure` 增加必填 `modelContent`，格式为 `工具调用失败（<code>）：<message>`。
- `toFailure` 在生成结构化失败时同时生成该文本，保证所有业务失败路径一致。
- `registry.createModelTool().execute` 对 `ToolFailure` 直接返回 `result.modelContent`，不再抛 `ToolExecutionError`。
- `executeToolCall` 仍对 handler 抛出的非业务异常向上抛出；真正的进程/磁盘/实现错误不会被伪装成模型可恢复结果。
- AI SDK 侧因此收到正常工具返回值；工具活动仍走既有 `tool-result`/`tool-execution-finished`，不会产生 `tool-error`。
- 工具调用超时、取消、非法输入、输出过大等已归一化为 `ToolFailure` 的路径，同样作为模型结果返回。

## 曾考虑的替代方案

- **继续抛错并依赖 AI SDK `toResponseMessages` 转成模型文本：** 舍弃。SDK 虽然可能把错误投影为文本，但事件和调用语义仍是 `tool-error`，不满足“工具执行失败不是工具执行错误”的要求。
- **在 registry 捕获所有异常并返回文本：** 舍弃。会把基础设施异常也伪装成业务结果，掩盖真实故障；只有 `ToolFailure` 才转为模型内容。
- **让每个工具 handler 自己生成失败文本：** 舍弃。错误码与文本格式会分散，且 handler 仍可能抛错；统一由执行器生成。
- **新增 `tool-warning` 或独立失败事件：** 舍弃。没有新增跨进程事实的需求，复用既有工具结果通道即可。

## 后果与防回退

- 正面后果：模型能看到明确失败原因并调整参数；工具活动不再把可恢复业务失败显示为执行错误；错误文本格式统一。
- 代价：工具失败不再触发 AI SDK 的错误回调；依赖该回调做告警的代码需要改用工具结果事件。当前实现只依赖既有 finish 事件，未发现第二消费者。
- 防回退：
  - `ToolFailure` 必须携带 `modelContent`，不得让 registry 重新抛业务错误。
  - 基础设施异常必须继续抛出，不得被 catch-all 转成模型结果。
  - 不得为同一失败同时写 `tool-error` 和 `tool-result` 两套事实。

## 验证

- `apps/agent/test/core/tool/executeToolCall.test.ts`：校验失败、handler 业务失败和超时均断言 `modelContent`。
- `apps/agent/test/core/tool/registry.test.ts`：授权后的模型工具对业务失败 resolve 为失败文本，而非 reject。
- `pnpm --filter @answra/agent typecheck`：通过。
- `pnpm verify`：Biome、全包 typecheck、全包测试与架构检查通过；Agent 193 项、UI 229 项、desktop 277 项测试通过。
- `pnpm notes:check`：通过。
- 真实模型 function calling 与 UI 工具活动尚未实机验收。
