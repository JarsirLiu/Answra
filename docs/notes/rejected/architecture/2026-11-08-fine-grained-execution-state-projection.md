# Note：否决细粒度执行状态投影

状态：已拒绝：细粒度执行状态快照超出当前单实例产品需求，并会复制事件与消息对象状态。

## 问题

曾提议从同一 `AgentEventEnvelope` reducer 同时维护 Session、Run、Step、Tool、Part 多类状态快照，并为这些快照定义共享 schema、查询接口和 revision 协议。虽然没有增加第二个事件流，但会把每个事件事实扩展为多份并行状态投影；当前产品没有独立查询这些对象快照或跨 Agent 重启恢复的需求。

## 涉及范围

- `packages/shared/src/schema/status.ts`、`apps/agent/src/execution/`、`apps/agent/src/core/transcript/` 和 UI 状态投影。
- 运行事件、消息历史、内存状态缓存及未来可替换存储适配器。

## 提案

拒绝将 Session、Step、Tool、Part 状态快照作为当前架构目标。当前只保留已有 Run 状态迁移与内存缓存。Transcript 保存可恢复的 Message/Part 内容及其内容状态；事件记录执行事实；其他运行状态需要时由单一 reducer 在内存按需计算，不建独立持久化表。

## 模块边界

- `packages/shared/src/schema/status.ts` 不再因为此提案扩充运行对象快照 schema。
- `apps/agent/src/execution/` 不增加 Session/Step/Tool/Part 快照 reducer 或查询 API。
- `apps/agent/src/core/transcript/` 继续拥有消息内容和消息终态；`apps/agent/src/execution/` 只负责事件和 Run 内存状态。
- 不改变现有 `AgentEventEnvelope` 事件目录。

## 曾考虑的替代方案

- **为每个对象建立状态表：** 可以快速查询，但会复制事件事实和消息对象状态，拒绝。
- **完全不缓存任何运行状态：** 数据模型最小，但每个 UI 消费者都要重复扫描事件，拒绝；保留现有 Run 内存缓存。
- **将所有状态放入 AgentEventEnvelope：** 会把当前值和历史事实混为一谈，拒绝。

## 否决理由

该提案将当前没有独立查询需求的 Session、Step、Tool、Part 都扩成状态快照与 reducer 阶段，增加实现和一致性维护成本。事件流已经能表达事实，Message/Part 能保存历史内容；当前只需要 Run 状态支撑执行控制和 UI。

## 后果与防回退

- 多类快照会复制事件和 Message/Part 已有的信息，带来同步、revision 和恢复复杂度。
- 当前 UI 所需运行指示可由明确 Run 状态和事件投影，不需要持久化完整对象状态矩阵。
- 将来需要重启或实例恢复时，先持久化 Transcript 和有回访价值的事件；仅在测量证明必要时增加可重建快照。

## 重新评估条件

只有出现明确的 Step/Tool 独立查询需求，且单一事件 reducer 已无法满足性能或 API 要求，才为具体对象重新提出最小快照。多实例接管需另行定义共享存储、租约、fencing 和未完成 Run 处理，不得由本 Note 推导为已有支持。

## 验证

本 Note 记录架构决定，不对应代码行为变更。相关共享 schema 和内存 store 的实现仍需按当前代码单独审查。
