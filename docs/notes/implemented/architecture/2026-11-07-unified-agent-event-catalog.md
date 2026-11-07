# Note：集中 Agent 事件目录并显式区分实时与持久化事件

状态：已实施

## 问题

Agent 的 31 种共享事件载荷分散在 `events.ts` 和 `stream.ts`。虽然 `AgentEvent` 已把它们组合成一个 union 和 envelope，但读者无法在一个位置查全事件清单。当前 store 是进程内实现，仓库尚无 durable event store；未来持久化时也不能把高频 delta 当作默认落盘事件。

## 涉及范围

- 代码/模块：`packages/shared/src/schema/events.ts`、`packages/shared/src/schema/status.ts`、`apps/agent/src/execution/`
- UI/进程/协议/持久化表面：跨包 Agent 事件契约、Agent 内存事件 store、UI 事件消费
- 相关 Note：`docs/notes/implemented/architecture/2026-11-07-complete-ai-sdk-event-contract.md`

## 决定

- 把全部 31 种 Agent 事件载荷和唯一 `AgentEventEnvelope` 放入 `packages/shared/src/schema/events.ts`，形成唯一完整事件目录；移除独立的 `stream.ts` schema 文件。
- 从完整 `AgentEvent` 派生 `AgentExecutionEvent` 和 `AgentStreamEvent` 类型别名，供现有消费端表达输入范围；不为它们再维护第二份事件 schema。
- 在同一文件定义明确的持久化资格目录。`text-delta`、`reasoning-delta`、`tool-input-delta` 属于实时流事件，不进入 durable event schema；其他事件列入持久化资格目录。
- `AgentDurableEvent` 仅表达未来持久化适配器允许写入的载荷种类，不表示已有 durable store、事件回放或恢复能力。
- `status.ts` 继续只定义状态词汇、状态快照及 retry/usage 值对象；状态迁移、事件 store 继续属于 `apps/agent/src/execution/`。
- transcript 的文本内容仍由 Conversation transcript 数据负责。由于文本 delta 不持久化，未来若要求仅凭 durable event stream 重建完整 transcript，必须另行定义最终文本持久化边界，不得从 delta 顺序推演或假称现有 `text-end` 已携带全文。

## 模块边界

- `packages/shared/src/schema/events.ts`：全部 Agent 事件载荷、实时事件 union、持久化资格 union、唯一 envelope。
- `packages/shared/src/schema/status.ts`：状态和状态快照，不定义事件。
- `apps/agent/src/execution/`：envelope 工厂、状态迁移规则和当前进程内 store；不另造事件定义。
- `apps/agent/src/core/model/`：把 AI SDK 流显式归一化为 shared 事件类型。
- `packages/ui/`：消费相同 envelope，不定义事实事件。

## 曾考虑的替代方案

- **继续按事件生产来源拆成 `events.ts` 和 `stream.ts`：** 舍弃。它没有形成两套运行时 stream，但完整清单仍分散，且 `events.ts` 名称看似总目录、实际只声明四种 payload。
- **把状态定义也并入事件文件：** 舍弃。状态和事件是不同契约；状态词汇及快照继续单独放在 `status.ts`。
- **现在实现数据库持久化和 replay：** 舍弃。当前 store 明确是进程内实现；本提案只定义事件持久化资格，不增加存储或恢复能力。

## 后果与防回退

- 共享 schema 现在集中于 `events.ts`；stream 与 execution 子集 schema 复用同一事件定义，禁止再创建平行的 payload schema 文件。
- 新事件必须加入完整 Agent 事件目录，并明确属于 durable 候选还是 live-only；新增高频 delta 默认不纳入 `AgentDurableEvent`。
- 当前没有 durable store、事件回放或进程恢复；不得把资格 schema 描述成已持久化。
- 不持久化 delta 的选择意味着事件 durable stream 单独不能重建完整 assistant transcript；未来持久化 transcript 必须走 Conversation 数据边界。

## 验证

- `pnpm --filter @answra/shared typecheck`：通过。
- `pnpm --filter @answra/shared test`：5 项通过，覆盖 31 种事件、28 种 durable 候选和三种 live-only delta。
- `pnpm verify`：全包 typecheck、643 项测试、lint 和 architecture check 通过。
- `pnpm notes:check` 与 `git diff --check`：随后完成。

## 风险

- Durable 资格不是实际持久化证明。事件 store 目前仍是进程内实现。
- delta 不进入 durable 事件目录意味着 durable event replay 本身不足以重建逐字输出；Conversation transcript 的持久化边界仍需独立保证。
- 若未来新增高频增量事件，必须明确分类为实时事件或持久化资格事件，并补齐对应 schema 测试。
