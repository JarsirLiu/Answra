# Note：事件 schema 单一来源与 AI SDK 边界

状态：已实施

## 问题

对话与面试共用会话消息和流式事件，但当前事件类型散落在 `packages/shared` 与 `apps/agent`，且 `packages/shared/src/channels/conversation.ts` 直接 `import type { UIMessageChunk } from "ai"`。后果：

- IPC 与持久化载荷绑定 AI SDK 版本，SDK 升级会改变跨进程契约；
- `UIMessageChunk` 包含 `providerMetadata`、`source-url`、`file` 等大量非产品字段，store 与 UI 被迫理解供应商细节；
- agent 的 run 生命周期（`start`/`finish`/`abort`）与消息内容事件混在一起，无法统一表达失败、取消和代际过期；
- 面试回复复用 `general-chat`，事件与策略都向对话漂移。

需要把“事件长什么样”冻结在一处，所有进程只引用这一处。

## 涉及范围

- 代码/模块：`packages/shared/src/schema/`、`packages/shared/src/channels/conversation.ts`、`apps/agent/src/core/`、`apps/agent/src/conversation/`、`packages/ui/src/app/`、`apps/desktop/src/main/window.ts`。
- UI/进程/协议/持久化表面：renderer IPC 的 `ConversationChange` 载荷；agent worker 的 `AgentFrame.change`；内存 store 的 journal；UI 的 `useConversationChat` / `useReplyConversation` / `interviewConversation`。
- 相关 Note：[产品方向与 Agent 底座](../../proposed/architecture/2026-10-20-product-direction-and-agent-foundation.md)、[面试语音运行时模块边界](../../proposed/architecture/2026-10-19-interview-runtime-module-boundaries.md)、[对话与答题 AI 领域拆分及对话能力复用](../../implemented/architecture/2026-10-18-ai-capability-domains-and-reuse.md)。

## 决定

### 单一 schema 源

在 `packages/shared/src/schema/` 用 Zod 定义唯一事件和会话类型，并通过 `@answra/shared/schema` 子入口导出运行时 schema，通过 `z.infer` 导出 TypeScript 类型。根入口只 re-export 类型，避免把 Zod 带进 renderer 运行时。

```text
packages/shared/src/schema/
  agent.ts       AgentStreamEvent、RunOutcome
  session.ts     ConversationMessage、ConversationSnapshot、ConversationEvent、ConversationChange
  index.ts
```

### 事件分层

```text
AI SDK UIMessageChunk         只在 apps/agent/src/core/streamEvents.ts 出现
        ↓ normalizeStreamChunk
AgentStreamEvent              app-owned 稳定子集（text/reasoning/tool/source/error）
        ↓ store 追加 seq/revision
ConversationEvent             { conversationId, runId, seq, revision, stream }
ConversationChange            snapshot | messages-appended | event | run-finished
        ↓ IPC
UI 领域 reducer
```

`start`/`finish`/`abort` 不再作为内容 chunk 持久化：

- `start` 由 `messages-appended.activeRunId` 表达，或作为最小的 `AgentStreamEvent.start` 保留给 UI 状态；
- 终态统一由 `run-finished` 的 `outcome: "completed" | "failed" | "aborted" | "superseded"` 表达；
- 错误先记录 `error` 事件，再以 `failed` 结束；
- 取消/顶替映射为 `interrupted` 消息状态。

### 归属规则

- `packages/shared` 不得 import `ai`。
- `UIMessageChunk` 只允许出现在 `apps/agent/src/core/`；对话与面试领域不得直接消费。
- `packages/ui` 可以继续使用 AI SDK 的 `useChat`/`UIMessageChunk` 做聊天渲染，但必须通过 app-owned 事件适配，不把 AI SDK 类型放进 shared。
- `ConversationChange` 暂保留现有命名，避免本次同时做 `Session*` 重命名；重命名作为后续独立变更。

### 明确不做

- 不把 `UIMessage` 直接作为持久化模型；`parts`、provider metadata 和工具状态等 UI 字段不进入 store。
- 不让面试复用对话 profile；面试回复使用自己的 profile 与策略（单独变更）。
- 不引入第二套校验库；Zod 与 AI SDK 依赖树中的版本对齐。

## 模块边界

- `packages/shared/src/schema/`：唯一 schema 与类型来源。
- `apps/agent/src/core/streamEvents.ts`：AI SDK chunk → app event 的唯一归一化点。
- `apps/agent/src/conversation/runtime.ts`：只负责编排模型调用与 store 写入，不再向 store 写 AI SDK chunk。
- `apps/agent/src/conversation/store.ts`：维护 `seq` 与会话 `revision`，终态由 `run-finished` 发布。
- `packages/ui/src/app/`：消费 app event；`useConversationChat` 负责把 app event 适配成 `useChat` 需要的 `UIMessageChunk`。

## 曾考虑的替代方案

- **继续在 shared 中直接使用 `UIMessageChunk`：** 改动最小，但跨进程契约继续绑定 AI SDK 版本，且 store/UI 持续暴露供应商字段；舍弃。
- **新建 `packages/contracts` 专放 schema：** 边界更硬，但当前 `packages/shared` 已是跨进程契约包，新增包会制造第二个“契约中心”；等出现非 Answra 消费方再拆。
- **只写 TypeScript 类型、不做运行时 schema：** 无运行时校验，跨进程与持久化读取无法防漂移；至少边界需要 Zod。
- **直接把 `UIMessage` 作为持久化消息：** 能复用 AI SDK 的 parts 渲染，但缺少 `status`/`activeRunId`/`revision`，且把 provider metadata 带入 store；当前 UI 只需要文本，舍弃。

## 验收标准

- 可观察结果：`packages/shared` 不再依赖 `ai`；`UIMessageChunk` 只出现在 `apps/agent/src/core/`；IPC 仍能正常驱动对话与面试 UI。
- 自动化验证：schema 往返测试、chunk 归一化测试、store `seq`/终态测试、现有 runtime/host/UI 测试全绿；`pnpm verify` 通过。
- 需要的实机验证：对话发送、截图答题、面试语音回复三条链路在 Windows 上各跑一轮。

## 风险

- UI 的 `useChat` 依赖 `UIMessageChunk` 的 start/finish/abort 帧；适配层必须保证流正常关闭，否则聊天会停在“思考中”。
- 当前工作区还有未提交的面试语音闭环改动；本变更与其重叠，必须按测试逐步收口，不能把行为变化混进 schema 迁移。
- `RunOutcome` 与消息状态是新增语义，错误轮从 `complete` 改为 `failed` 会影响既有断言；需要同步更新测试与 UI 状态判断。

## 后果与防回退

- `ConversationEvent.stream` 与 `run-finished.outcome` 是持久化/IPC 的唯一内容事件与终态；新增事件类型必须同时修改 `packages/shared/src/schema/` 和 `apps/agent/src/core/streamEvents.ts`，否则类型检查会失败。
- `packages/shared` 不得重新依赖 `ai`；`UIMessageChunk` 只允许出现在 `apps/agent/src/core/`。架构脚本已加入这两条检查。
- `seq` 由 store 按 run 分配；未来 SQLite 实现必须按 `(runId, seq)` 幂等，并在 `run-finished` 后清理该 run 的序号。
- `packages/ui` 可以继续使用 AI SDK 的 `useChat`，但必须通过 `useConversationChat` 的适配层；不得把 `UIMessageChunk` 写回 shared 契约。

## 验证

- `pnpm --filter @answra/shared test`：3 passed。
- `pnpm --filter @answra/agent test`：123 passed。
- `pnpm --filter @answra/ui test`：205 passed。
- `pnpm --filter @answra/{shared,agent,ui,desktop} typecheck`：通过。
- `pnpm lint`、`pnpm architecture:check`、`pnpm notes:check`：通过。
- 未完成：Windows 实机验证对话发送、截图答题、面试语音回复三条链路。
