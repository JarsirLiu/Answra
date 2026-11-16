# Note：Provider 上下文超限的单次恢复

状态：已实施

## 问题

自动压缩原本只在模型请求发出前执行：`ContextPreparation.prepareRequest` 估算最终请求，达到 `compactAt` 才调用 `ContextCompactor`。本地估算可能低于 provider 的真实限制，原因包括图片、工具 schema、协议开销、tokenizer 差异或端点声明的窗口不准确；provider 拒绝请求后，旧 `executeRun` 只把错误写成终态事件，这一轮直接失败。

代码里已有 `isContextOverflowError`、`AgentRunRequest.recoverContext` 和 `ContextPreparation.recoverRequest` 三个半成品，但 `executeRun` 没有消费恢复回调；AI SDK 的 provider 错误也通常以流内 `error` part 出现，不一定 throw，因此“provider 超限后压缩一次再重试”只有接口骨架。

本变更只解决 provider 超限后的单次恢复，不重写既有自动压缩，也不把恢复提升为新的会话、run 或 Bot 交接。

三个概念必须分开：

- **自动压缩（preflight）**：provider 请求发出前，按预算阈值主动压缩。
- **单次恢复（reactive）**：provider 明确报上下文超限后，压缩一次并重试同一个逻辑请求一次；每个 run 最多一次。
- **多 Bot 交接（handoff）**：当前 Bot 正常结束后输出交接结果，会话归属转移给目标 Bot，再启动新的 run；与恢复属于不同层。

“单次”指每个 run 最多一次恢复尝试，不是“只摘要一条消息”。摘要本身仍可覆盖多条历史消息。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/agent/executeRun.ts`：识别 provider 超限，调用一次 `recoverContext`，在同一个 run 内重试；第二次超限落终态。
  - `apps/agent/src/core/agent/modelAttempt.ts`：新增单次模型尝试消费器，缓冲内容前生命周期、返回流终态；恢复时丢弃失败尝试的缓存事件。
  - `apps/agent/src/core/agent/definition.ts`：沿用现有 `recoverContext` 契约，补充“同一 run、不写 transcript、不启动新 run”的约束。
  - `apps/agent/src/core/context/preparation.ts`：`recoverRequest` 只在真正完成压缩时返回请求；熔断、失败、取消都返回 `undefined`。
  - `apps/agent/src/core/model/contextOverflow.ts`：继续作为唯一超限分类入口。
  - `apps/agent/src/conversation/application.ts`、`apps/agent/src/coding/application.ts`、`apps/agent/src/interview/application.ts`：在各自 `startRun` 接线 `recoverContext`。
  - 删除 `apps/agent/src/core/model/consumeStream.ts`；其流消费职责并入 `modelAttempt.ts`，避免两套流终态语义。
- UI/进程/协议/持久化表面：
  - 不新增 shared IPC、worker 命令或桌面/CLI 入口。
  - 不新增用户消息、不新增 `AgentRun`、不改变队列完成语义。
  - 压缩状态仍写 `ContextState.compaction`，trigger 复用 `auto`；未新增 `provider-overflow` 状态值。
- 相关 Note：
  - [会话上下文摘要压缩与旧上下文归档](../../proposed/architecture/2026-11-13-conversation-context-compaction-and-archive.md)
  - [256k 上下文预算与旧工具结果清理](../../implemented/architecture/2026-11-13-context-budget-and-tool-result-clearing.md)
  - [多 Bot 会话目录与交接](../../proposed/architecture/2026-11-11-multi-bot-session-registry-and-handoff.md)
  - [Conversation 编排拆分与 Bot 边界收敛](../../proposed/architecture/2026-11-12-conversation-orchestration-decomposition.md)

## 决定

### 1. 两个入口共用同一压缩核心

自动压缩和超限恢复都经过 `ContextPreparation` + `ContextCompactor`，没有复制摘要、checkpoint、裁剪或 usage 逻辑。

```text
准备阶段
  prepareRequest()
    -> 估算最终请求
    -> 达到 compactAt 时 compact（自动压缩）
    -> 发送 provider 请求

provider 尝试
  -> 成功：正常消费流
  -> 非超限错误：按现有终态失败
  -> 超限且尚无模型内容：
       recoverContext()
         -> recoverRequest({ forceCompact: true, trigger: "auto" })
         -> compacted：重建请求，重试一次
         -> undefined：发布原始超限错误并结束
  -> 第二次超限：不再恢复，按普通失败结束
```

自动压缩是“预防”，reactive 是“补一次”。两者都不新增用户消息、不新建 run、不改变当前 `runId`。

### 2. 每个 run 只允许一次恢复

`executeRun` 用 `contextRecovered` 状态显式限制恢复次数：

- 每个 run 最多调用一次 `recoverContext`；
- 只有第一次 provider 尝试可以触发恢复；
- 第二次尝试无论结果如何都不能再恢复；
- 用户取消、队列取消或 run abort 后不得重试；
- 恢复失败只发布原始 provider 超限错误，不把摘要错误伪装成用户消息失败原因。

### 3. “尚无模型内容”是硬条件

只有 provider 超限发生在“还没有对用户产生可观察输出或工具副作用”时，才允许恢复。以下任一事实出现后都直接失败：

- 已产生 `text-delta` 或 `text-end`；
- 已产生 `reasoning-delta`；
- 已产生 `tool-call`、`tool-result` 或其他工具执行事实；
- 已向 transcript 写入 assistant 内容；
- 已经发生工具调用或任何外部副作用。

### 4. 首段事件缓冲，恢复时丢弃

`modelAttempt.ts` 的 `createModelAttemptSink` 在“尚无模型内容”阶段缓存 `start`、`step-started`、`text-start` / `reasoning-start` 和 model warning，不立即写 `ExecutionStore`；出现第一条内容或工具事实时按原顺序 flush，恢复时直接 discard。这样同一个 run 不会留下两次 `start` / `step-started`。

不可恢复错误会先 flush 缓存再写原始错误；第二次尝试重新建立自己的缓冲。正文流式输出不受影响。

### 5. 恢复使用自动压缩语义

三个领域的 `recoverContext` 都只把 provider 错误接入现有上下文准备：

```ts
recoverContext: (modelRequest, rebuild, _error, signal) =>
  this.contextPreparation.recoverRequest({
    conversationId,
    getAccessToken,
    modelRequest,
    rebuild,
    signal,
    onStatus,
  });
```

约束：

- `recoverRequest` 固定 `forceCompact: true`；
- trigger 使用默认 `auto`，与普通自动压缩共用失败熔断；
- 不传 `bypassFailureBreaker`，provider 恢复不能绕过自动熔断；
- 手动 `/compact` 的 `trigger: "manual"` 和 `bypassFailureBreaker: true` 保持不变；
- `recoverRequest` 只在 `compaction.status === "compacted"` 时返回重建请求；`skipped`、`failed`、`aborted` 都返回 `undefined`，调用方不重试。

### 6. 与多 Bot 交接保持分层

多 Bot 交接是“run 链”，provider 超限恢复是“同一 run 内的一次尝试重试”，没有合并成同一个原语。

当前 `ConversationApplication.continueTeamTurn` 仍然是：

```text
Bot A run completed
  -> result.kind === "handoff"
  -> appendHandoffMessage()
  -> start Bot B run
```

这是正常结束后的新 run，会写交接 transcript、转移 `activeAgentId`。它不能复用 `recoverContext`，因为恢复属于同一个 Bot、同一个逻辑回合；反过来，provider 超限也不能复用 `handoff` 控制结果。

首版不做中途交接。现有“完成后交接”保持原样。

### 7. 明确不做

- 不做多次恢复或指数退避重试；
- 不在已有文本、推理或工具副作用后恢复；
- 不新建 run、不新建用户消息、不写交接记录；
- 不新增 `provider-overflow` 状态枚举或 UI 文案；
- 不修改手动压缩的熔断绕过与结果契约；
- 不把多 Bot 交接改成 provider 恢复的同义词；
- 不在 `executeRun` 里复制 provider 错误字符串分类。

## 模块边界

- `core/agent/executeRun` 拥有 provider attempt 生命周期、恢复次数和事件缓冲；它只决定“能否重试一次”，不实现摘要。
- `core/agent/modelAttempt` 拥有单次流的消费、内容前缓冲和终态识别；它不决定是否恢复。
- `core/context` 拥有预算、选段、摘要、checkpoint、usage 和失败熔断；它不读取 provider 错误类型之外的领域语义。
- `core/model/contextOverflow` 是唯一的超限分类入口；领域和 `executeRun` 都复用它。
- 三个领域应用只提供 `recoverContext` 接线，不复制恢复判定、不直接调用 `ContextCompactor`。
- `conversation/application` 继续拥有 Bot 交接与 `activeAgentId` 转移；`core/agent` 不得 import 领域交接代码。
- transcript 与 ExecutionStore 不感知“这是一次恢复”；恢复成功时只表现为同一个 run 的后续事件。

## 曾考虑的替代方案

- **只依赖请求前估算，不做恢复。** 舍弃。估算必然存在图片、工具 schema、tokenizer 和 provider 差异，超限仍会稳定发生；实机 413 验证也说明必须保留 overflow 兜底。
- **允许无限次或固定多次恢复。** 舍弃。每次恢复都要调用摘要模型，可能重复工具副作用；第二次仍超限说明当前上下文无法压到限制内，继续重试只会放大延迟和费用。
- **为恢复创建新的 Agent run。** 舍弃。会改变 `runId`、队列完成和 UI 终态，还会让一次 provider 重试看起来像新回合；恢复必须留在同一 run 内。
- **把恢复做成多 Bot 交接的一个分支。** 舍弃。交接转移会话所有者和 transcript 记录，恢复不转移所有权、不写用户可见消息；合并会让两套语义互相污染。
- **新增 `provider-overflow` 压缩 trigger。** 暂不采用。当前 UI 只需要知道“自动/手动”；复用 `auto` 避免扩展 shared schema、桌面和 CLI 文案。若后续需要区分恢复来源，再单独扩展。
- **直接照搬 opencode 的 turn transition。** 暂不采用。Answra 的 run 已绑定队列、取消和 execution journal；在 `executeRun` 内做一次重试更小，但必须用 pre-content 缓冲保证不重复事实。实测事件顺序后采用当前方案。
- **复用手动压缩的 `bypassFailureBreaker`。** 舍弃。自动恢复若绕过熔断，会让持续失败的摘要请求无限触发；手动入口才需要用户显式绕过。

## 后果与防回退

- 恢复成功后，调用方只看到同一个 `runId` 的后续事件、最终 assistant 回复和刷新后的上下文占用；不会出现第二个 run。
- 恢复前失败尝试的 `start` / `step-started` 被丢弃；已有内容或工具事实后绝不重试，避免重复输出和重复工具副作用。
- `ContextPreparation.recoverRequest` 的返回值是“是否真的可以重试”的唯一契约；后续修改不得再无条件返回请求。
- 自动恢复不计入手动压缩的绕过路径；摘要失败继续按自动路径累计熔断。
- 任何新增领域都要在 `startRun` 接线 `recoverContext`，并复用 `isContextOverflowError` 与 `recoverRequest`，不得自建错误文案匹配或第二套压缩。
- 不得把 provider 超限恢复改写成新 run 或 handoff；那会破坏队列、transcript 和 Bot 所有权语义。
- 删除 `consumeStream.ts` 后，模型流只能经 `modelAttempt.ts` 进入 journal；不要恢复第二套消费器。

## 验证

- 自动化验证：
  - `apps/agent/test/core/agent/executeRun.test.ts`：真实本地 HTTP 413 后压缩并重试同一 run；第二次 413 不再恢复；`recoverContext` 返回 `undefined` 时保留原始错误；首次尝试生命周期被丢弃且 `start` / `step-started` 各只有一次。
  - `apps/agent/test/core/agent/modelAttempt.test.ts`：内容前缓冲与顺序 flush、恢复时 discard、流内错误返回原始 error、内容后错误不可恢复、abort、finish、无终态。
  - `apps/agent/test/core/context/preparation.test.ts`：`recoverRequest` 成功只在真正压缩后返回请求；熔断开启时拒绝恢复；摘要失败时返回 `undefined` 并累计自动失败计数。
  - `apps/agent/test/conversation/teamHandoff.test.ts`：Conversation Bot run 已接线 `recoverContext`。
  - `apps/agent/test/coding/application.test.ts`：Coding Bot run 已接线 `recoverContext`。
  - `pnpm --filter @answra/agent test`：73 个文件、541 个测试通过。
  - `pnpm --filter @answra/agent typecheck` 通过；`pnpm lint` 通过。
- 实机验证边界：
  - 本地 HTTP 413 模拟验证的是 AI SDK `AI_APICallError` 流内错误形态；未接入真实供应商做长时间压测。
  - 未在桌面 GUI 与 CLI TUI 上人工触发真实 provider 超限；UI 行为沿用既有 `ContextUsage` / `compaction` 状态投影。
