# Note：一次性答题运行改为仓储原子认领

状态：已实施

## 问题

`ConversationRuntime.runAnswer` 在运行开始前执行「load 检查 activeRunId → clear 清残留 → beginRun 占位」四步操作，每步之间都有 `await`。并且在 `finally` 中运行的收尾 `clear` 同样只能在运行结束后才被调用。这套序列的安全保证依赖一个偶然事实：`MemoryConversationStore` 的所有方法都是同步体，Node 的微任务 FIFO 让两条并发链严格成对推进，`beginRun` 的原子守卫总是先于破坏性清空生效。

经微任务排布推演与并发审计测试确认：**当前同步内存形态下不可达**。但 `ConversationStore` 端口按 [后端拥有会话与内存仓储](../architecture/2026-10-12-conversation-memory-store-port.md) 明确计划替换为 SQLite（真实 I/O 挂起）：一旦任一 store 方法真实异步，load 返回陈旧快照后 `clear` 可以落在在途 run 的 `beginRun` 之后，把活动 run 的消息与 `activeRunId` 一并抹掉，使在途流式写入被 `appendEvent` 以「会话没有匹配的活动 run」拒绝，两侧流全部损坏。审计测试已实证该破坏形态（两次 `runAnswer` 都成功、产生两个 runId、第一题消息消失、流式写入报错）。

问题属于**契约级前瞻缺陷**而非当前可达 bug，但在 SQLite 迁移前必须把不变量从「调度巧合」改回「代码结构」。

## 涉及范围

- 代码/模块：`apps/agent/src/conversation/store.ts`（端口新增 `beginEphemeralRun`，`clear` 收紧）、`apps/agent/src/conversation/runtime.ts`（`runAnswer` 收敛为单次调用）。
- UI/进程/协议/持久化表面：无 shared/IPC/线协议变化；行为等价（并发第二次仍收到「当前回复尚未完成」失败码）；为未来 SQLite adapter 增加一个必须实现的端口方法。
- 相关 Note：[后端拥有会话与内存仓储](../architecture/2026-10-12-conversation-memory-store-port.md)、[截图答题使用一次性会话](../architecture/2026-10-13-screenshot-ephemeral-conversations.md)、[对话与答题 AI 领域拆分及对话能力复用](../architecture/2026-10-18-ai-capability-domains-and-reuse.md)。

## 根因

两个缺陷叠加：

1. **不变量分布但要约跨界**：一次性答题的「检查 → 清理 → 占位」由 runtime 跨三个以上 `await` 完成，而 [后端拥有会话与内存仓储](../architecture/2026-10-12-conversation-memory-store-port.md) 已规定 「并发：同一会话只允许一个活动 run，beginRun 原子拒绝并发写入」由**仓储**原子保证。runtime 抢着在检查后做破坏性 `clear`，把仓储的原子域降级成了调度运气。
2. **`clear` 无条件破坏**：`MemoryConversationStore.clear` 不校验活动 run 即清空 messages 与 journal。并发 begin 竞态下「迟到的收尾清理」与「新一轮的残留清理」无法区分，都会命中在途 run 的状态。

## 修复

- 端口新增 `beginEphemeralRun(conversationId, runId, userMessage)`：在同一步内完成「有活动 run 时抛『当前回复尚未完成』→ 清空上一轮残留消息与 journal（revision 保持单调）→ 安装本轮 user/assistant 消息对并发布 `messages-appended`」。内存实现的同步体使其天然原子；端口契约要求未来 SQLite 实现把该迁移放进同一事务并按会话串行。
- `clear` 收紧为**仅空闲清理**：会话仍有活动 run 时直接 no-op（不发事件、不抛错）。收尾清理落在新一轮认领之后时（SQLite 真实挂起下的交错），只会无害跳过——新认领的 `beginEphemeralRun` 已负责清理上一轮残留。
- `runAnswer` 收敛为一次 `startRun` 委派：删除自身 `create/load 检查/clear` 三步，由 `startRun` 统一 `create` 后按 ephemeral 分支调用 `beginEphemeralRun` 或 `beginRun`。附带的次序修正：未配置端点时现在先抛「云端模型服务尚未就绪」，不再先创建/清空会话。

## 复盘：两轮审查

首轮评审本缺陷被误判为「当前可达竞态」，理由错误（认为 check 与 clear 之间存在调度窗口——实际二者在同一微任务内机械相邻）；经微任务 FIFO 推演 + 审计测试实测后撤回，并降级为「SQLite 前置隐患」。本 Note 同时修复隐患并固化消除路径，防止 SQLite 迁移时把「今天的巧合安全」直接搬进真实 I/O。

## 决定

「同一会话同时最多一个活动 run」的不变量由仓储独占持有：一次性答题的运行开始收敛为端口原子操作 `beginEphemeralRun`（检查 → 清残留 → 占位，不可拆分），`clear` 收紧为仅空闲清理，runtime 不再跨 `await` 转运该不变量。SQLite 落地时同一不变量放进同一事务。

## 曾考虑的替代方案

- **runtime 持有 per-conversation 认领表（claim map）：** 检查+认领在同一同步块内，天然免疫任何 store 形态。舍弃：与 store 的 `activeRunId` 构成双真相源，会话状态恢复（断线补发、未来 SQLite 启动恢复）时需要同步两边，违反「仓储拥有会话状态」的既有边界；并发防护归仓储所有与 2026-10-12 Note 的验收标准一致。
- **只给 `clear` 加运行中守卫、保留 runtime 三步：** 挡住迟到的收尾清理，但两次并发 `beginRun` 的「检查→清理→占位」交错仍能制造陈旧快照通过检查 + 清空在途 run 的序列；不彻底，舍弃。
- **先迁移 SQLite 再处理：** 迁移时必然要写串行化实现，届时带病端口会直接复现破坏序列；修复端口形状是迁移的前置工作而非后续债务，舍弃。

## 后果与防回退

- `ConversationStore` 端口契约新增硬性要求：`beginEphemeralRun` 的「检查→清理→安装」必须是不可拆分的状态迁移，SQLite 实现须在同一事务内完成并按会话串行；仓储契约测试继续是 SQLite adapter 的准入门禁（沿用 2026-10-12 Note 的防回退条款）。
- `clear` 的调用方必须满足「运行已结束或无会话活动」前提；任何「运行中强制清空」的新需求不得恢复无条件 `clear`，需另设计破坏性端口方法并单独评审。
- 一次性答题的行为等价性不得回归：并发第二次 `runAnswer` 的用户可见失败码仍是「当前回复尚未完成」；`activeRunCount` 在运行结束后归零。
- 多轮对话（`beginRun`）路径不受本修复影响，其原子守卫保持原有出口消息。

## 验收标准

- 可观察结果：同一会话并发两次 `runAnswer` 恰好一次被拒（「当前回复尚未完成」）、存活者流式完整无 error chunk、运行结束后一次性会话清空；串行多次答题的残留清理与 revision 单调行为不变。
- 自动化验证：store 级测试覆盖 `beginEphemeralRun` 的原子拒绝（无副作用）、残留清空与 journal 降级回退、`clear` 的运行中 no-op；runtime 级并发回归测试在同步内存形态与「每个端口方法真实挂起一个宏任务」的异步形态下均保持单活动 run 不变量。异步形态测试在旧代码（四步序列）下必然复现损坏，作为防回退证据。
- 需要的实机验证：桌面端快速双击截图答题发送，确认第二个请求收到「当前回复尚未完成」且第一个回复流正常完成。

## 风险

- 端口多一个方法：任何未来的第二个仓储实现（SQLite）必须实现 `beginEphemeralRun` 并满足串行化契约；遗漏会导致编译期失败，属可接受的强制点。
- `clear` 的运行中 no-op 依赖调用方顺序正确（finishRun 先于 clear）；若未来出现「未结束就 clear」的调用方，清理会被静默跳过——由 store 级测试守住该契约，发现新调用方时必须复核其结束顺序。

## 验证

- `apps/agent/test/conversation/store.test.ts` 新增 3 项：一次性运行原子认领（残留清空、revision 单调、journal 降级）、活动 run 中并发认领原子拒绝且无副作用、`clear` 运行中 no-op。
- `apps/agent/test/conversation/runtime.test.ts` 新增 2 项：并发 `runAnswer` 单活动不变量（同步形态）；「每个 store `await` 跨一个宏任务」的异步端口形态下同一不变量（`setImmediate` 挂起每个方法）。
- `pnpm --filter @answra/agent test` 全量通过；全包 typecheck、`pnpm notes:check` 与仓库门禁（biome lint）通过。
