# Note：为托管 Agent 预留执行事实 schema

状态：已实施

## 问题

当前会话事件已经能驱动桌面 UI，但只覆盖文本/思考/工具展示和一次运行终态。AI SDK 还提供模型步骤、结束原因、token usage、工具审批等事实。未来若把 Agent 改为网站多租户、多个无状态实例，不能让 Redis 或某个 Agent 进程临时发明这些字段。

## 涉及范围

- 代码/模块：`packages/shared/src/schema/status.ts`、`packages/shared/src/schema/events.ts`、`packages/shared/src/schema/conversation.ts`
- UI/进程/协议/持久化表面：当前桌面会话合同保持兼容；未来执行器、事件存储和多租户适配器消费新增 schema
- 相关 Note：[事件 schema 单一来源与 AI SDK 边界](2026-11-03-event-schema-single-source.md)、[产品方向与 Agent 底座](../../proposed/architecture/2026-10-20-product-direction-and-agent-foundation.md)

## 决定

在 shared schema 冻结平台无关的执行词汇：状态和快照位于 `packages/shared/src/schema/status.ts`，Agent 事件与 envelope 位于 `packages/shared/src/schema/events.ts`：

- run 状态：`queued`、`claimed`、`running`、`retry-wait`、`completed`、`failed`、`aborted`、`superseded`、`orphaned`；
- step 状态：`started`、`streaming`、`tool-awaiting`、`tool-running`、`completed`、`failed`、`aborted`；
- part 类型：`text`、`reasoning`、`tool`、`source`、`file`、`data`；
- AI SDK 的 finish reason 与标准 token usage；
- 带 `eventId`、`runId`、`attemptId`、`stepId`、`sequence`、`aggregateRevision`、`causationId`、`correlationId`、`producerId`、`occurredAt` 的事件 envelope；
- 可选 `tenantId` 和 `actorId`，当前桌面端不伪造或启用租户隔离。

当前 `ConversationEvent` 和桌面 IPC 不迁移到 envelope；它们继续服务现有产品。未来第二个执行消费者到场时，模型执行器将把 AI SDK 的 `start-step`、`finish-step`、`finish`、`abort`、usage 与工具审批事实映射到 envelope，再由 Redis/数据库 adapter 持久化。

## 架构边界

- AI SDK 类型只出现在 `apps/agent/src/core` 的归一化边界；shared 不依赖 AI SDK。
- `execution.ts` 只定义事实和状态，不定义 Redis key、租约实现、重试算法或产品文案。
- 领域 runtime 仍拥有 profile 和业务状态；未来 core 执行器负责生成 run/step/part 事实。
- `eventId` 与序列号由事件存储端口的单 writer 生成；不能由 UI 推导，也不能由多个 Agent 实例各自猜测。

## 模块边界

- `packages/shared/src/schema/status.ts`：只定义跨进程执行状态与快照，不依赖 AI SDK、Redis 或 Electron。
- `packages/shared/src/schema/events.ts`：集中定义 Agent 事件与唯一 envelope，不依赖 AI SDK、Redis 或 Electron。
- `apps/agent/src/core`：未来负责把 AI SDK 的模型事实归一化为执行事件；本轮不改变现有领域 runtime。
- `apps/agent/src/conversation`：继续维护当前桌面会话 store 和 `ConversationEvent` 兼容合同。
- 未来 Redis/数据库 adapter：实现事件 envelope 的存储、幂等和重放端口，不改变领域状态定义。

## 曾考虑的替代方案

- **直接把 AI SDK `UIMessageChunk` 放进 shared：** 舍弃。会把 IPC、持久化和未来网站绑定到 SDK 版本和 provider 字段。
- **现在直接改造 Redis/多实例执行：** 舍弃。本轮没有部署需求，先冻结跨进程事实合同，避免为假想消费者实现未验证的分布式协议。
- **把所有新字段塞进 `ConversationEvent`：** 舍弃。当前桌面 IPC 已在使用旧合同，强迁移会把 UI、store 和 worker 混成一次无关的大改。

## 验收标准

- 可观察结果：shared 能校验未来托管 Agent 的 run/step snapshot 与事件 envelope；当前桌面会话行为不变。
- 自动化验证：schema 往返测试通过；shared、agent、ui typecheck 通过。
- 需要的实机验证：网站化前另行验证 Redis adapter 的幂等、顺序、租约 fencing、断线恢复和多租户隔离。

## 风险

- 当前 schema 只是架构前置，不会自动让已有 runtime 记录 usage 或 step 事件；接入执行器时必须补真实归一化和回放测试。
- `orphaned` 不是模型自然终态；只有协调器在确认实例失联后才能写入。

## 后果与防回退

- shared schema 不依赖 AI SDK；AI SDK 升级必须由 agent adapter 显式映射，不能把 SDK 类型直接透传到 IPC 或存储。
- 新增执行状态时只扩展 `status.ts`；新增 Agent 事件时只扩展 `events.ts`，并配 schema 测试；provider 原始字段与未知事件不得进入共享 envelope。
- `tenantId`、`actorId` 当前仅为可选契约字段，不代表现有桌面端有租户隔离或身份授权能力。
- Redis、数据库、租约、fencing token、消费确认与实例故障恢复均未实现；部署成多租户网站之前必须单独设计与验证这些机制。

## 验证

- `pnpm --filter @answra/shared test`：4 项通过。
- `pnpm --filter @answra/shared typecheck`：通过。
- `pnpm verify`：全包 lint、typecheck、测试和架构检查通过。
