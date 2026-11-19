# Note：CLI 上下文用量按模型响应刷新

状态：已实施

## 问题

CLI 底部 `ctx used/limit` 曾在用户发送消息时先跳到本地估算值，并在模型 step 完成时把输入与输出 token 相加。两者都不能代表最近一次模型请求的真实输入用量，导致状态行数字与 provider 后台记录不一致。

## 涉及范围

- 代码/模块：
  - `packages/shared/src/schema/events.ts`：新增 `context-usage-changed` Agent 事件。
  - `apps/agent/src/core/model/streamEvents.ts`：从 AI SDK `finish-step.usage` 生成该事件。
  - `apps/agent/src/core/model/provider.ts`：请求 OpenAI 兼容流式响应返回 usage。
  - `apps/agent/src/core/context/preparation.ts`：消费事件并持久化 `contextState.usage`。
  - `packages/ui/src/app/conversationView.ts`：事件投影直接更新 `ConversationView.contextUsage`。
  - `apps/agent/src/core/transcript/memoryStore.ts`：识别事件只推进 revision，不写入消息正文。
- 测试：`apps/agent/test/core/model/streamEvents.test.ts`、`apps/agent/test/core/context/preparation.test.ts`、`packages/ui/test/conversationView.test.ts`、`apps/cli/test/tui/app/viewStore.test.ts`
- UI 表面：CLI `/status` 与底部 `ctx used/limit`；桌面端复用同一投影。
- 不涉及：上下文预算、压缩阈值、工具结果清理策略；`ContextUsage` 增加可选来源标记，不改数据库结构。

## 根因

`ContextPreparation.prepare()` 在模型请求开始前把本地 token 估算写入 `contextUsage`，覆盖了最近一次 provider usage。此前的实时事件又将 `inputTokens + outputTokens` 作为上下文占用，造成发送前跳数且与后台口径不一致。

Codex 的对应做法是独立的 token usage 事件：每个模型响应完成后发送 `TokenCount`，TUI 收到后立即更新状态栏，不依赖 conversation snapshot。AI SDK 6 的 `finish-step` 已提供每一步的 `usage`，因此可以在现有 AgentEvent 流中复刻同样的语义。

## 决定

- 新增 `context-usage-changed` 事件，payload 只携带 `usedTokens`；上下文窗口、压缩阈值等稳定预算仍来自 `ContextUsage` snapshot。
- 在 `finish-step` 归一化时同时产出 `step-finished` 和 `context-usage-changed`；`usedTokens` 只取 provider 报告的 `inputTokens`，不加回答输出。
- OpenAI 兼容 provider 开启 `includeUsage: true`，确保流式响应携带 usage；未返回 usage 的端点保持上一次值。
- 普通发送前只更新预算和清理状态，沿用上一次 provider usage；首次收到 provider usage 前保持未知。
- UI 在 `applyAgentEvent()` 收到事件时立即更新 `contextUsage.usedTokens` 和 `updatedAt`，不再等待 snapshot。
- `ContextPreparation.recordRunEvent()` 收到事件后写回 `ContextState.usage`，供重启/恢复展示；snapshot 只负责持久化和恢复，不作为实时刷新链路。
- `context-usage-changed` 不触发 transcript 正文写入，只推进事件 revision。

## 修复

`normalizeStreamPart()` 在 `finish-step` 时同时产出 `step-finished` 与 `context-usage-changed`；后者携带 provider 的 `inputTokens`。provider 构造开启 `includeUsage: true`，请求结束后取得 usage。普通 `prepare()` 不再用请求估算覆盖已显示的 `usedTokens`；`recordRunEvent()` 收到事件后写回 `ContextState.usage`，UI 的 `applyAgentEvent()` 直接更新 `ConversationView.contextUsage`，CLI 不再依赖 snapshot 推送。

## 曾考虑的替代方案

- **继续用 `onSnapshot` 推送实时 usage**：snapshot 可能因 `eventRevision` 落后被 TUI 丢弃；实时性依赖异步时序；否决。
- **只改 UI 消费 `step-finished.usage`**：可行，但把 usage 语义绑在生命周期事件上，后续难以独立扩展或恢复；独立事件更清晰。
- **使用 `finish.totalUsage`**：它是整个 run 的累计值，且包含输出；ctx 需要最近一次模型请求的输入量，因此使用 `finish-step.usage.inputTokens`。
- **每个 step 重新执行 `prepare()`**：重复压缩/裁剪判断，且不是 provider 实际值；否决。

## 后果与防回退

- 每个模型 step 完成后，CLI/桌面状态栏都会刷新；发送消息本身不会用估算值覆盖上一条真实 usage。
- 每个 step 多一条轻量 AgentEvent，并触发一次 `contextState` 写库；不改变模型请求内容。
- provider 未返回 usage 时不发事件，保留上一次值，不回退到 0。
- 回归测试必须覆盖：`finish-step` 生成 usage 事件、UI 事件投影更新、`contextState` 持久化，以及 CLI store 在 run 结束前刷新。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/core/model/provider.test.ts test/core/model/streamEvents.test.ts test/core/context/preparation.test.ts`：30 项通过。
- `pnpm --filter @answra/ui exec vitest run`：334 项通过。
- `pnpm --filter @answra/cli exec vitest run`：390 项通过。
- `pnpm --filter @answra/agent exec vitest run`：667/672 通过；5 项在并行负载下超时，对应文件单独重跑均通过（`worker/host`、`tool/edit`、`tool/grep`、`transcript/databaseMigration`、`tool/shell/shellTools`）。
- `pnpm --filter @answra/shared typecheck`、`@answra/ui typecheck`、`@answra/cli typecheck`：通过。
- `@answra/agent typecheck`：本次变更文件无类型错误；全包检查被工作区中未完成的 interview-intake 改动阻断（`src/host.ts`、`test/conversation/application.test.ts`、`test/interview/agent.test.ts`），与本变更无关。
- `pnpm notes:check`：通过。
