# 事件、条目与双通道

本文件回答：模型流事件怎么变成 durable 条目、走哪条通道、按什么顺序落地。

## 三层

```text
模型流事件（内存，可丢）→ 结算条目（durable 唯一形态）→ 帧（对客户端的传输）
```

| 通道 | 载体 | 内容 | 可靠性 | 读取口 |
| --- | --- | --- | --- | --- |
| durable | `SessionFrame`（`SESSION_FRAME_SCHEMA_VERSION = 2`，带 `seq`） | 只有 `session-item`：一条已结算条目 | 断线按 `seq` 补齐，不许丢 | `readFramesAfter` / `answra:conversation:read-frames` |
| live | `LiveFrame`（无 `seq`、无 `eventId`） | 6 种：4 个 delta + `retry` / `error` | 可丢，正文与归因由条目兜底 | 订阅推送，不参与重放 |

定义在 `packages/shared/src/schema/session/frame.ts`（帧）与 `item.ts`（条目）；模型流事件目录仍在 `packages/shared/src/schema/events.ts`。

## 事件目录

| schema | 数量 | 内容 |
| --- | --- | --- |
| `agentStreamEventSchema` | 28 | 22 个 durable 候选 + 6 个 live-only |
| `agentDurableEventSchema` | 34 | 12 个生命周期/上下文事实 + 22 个流事件候选 |
| `agentLiveOnlyEventSchema` | 6 | `text-delta`、`reasoning-delta`、`tool-input-delta`、`tool-output-delta`、`retry`、`error` |

12 个事实：`turn-queued` / `turn-started` / `turn-finished` / `turn-handoff`、`compaction-*`（4）、`step-started` / `step-finished`、`context-usage-changed`、`part-state-changed`。

22 个流事件候选：生成生命周期（`start` / `finish` / `abort`）、文本/推理边界（4）、工具输入与请求（`tool-input-start` / `tool-input-end` / `tool-call`）、工具结果（`tool-result` / `tool-error` / `tool-output-denied`）、审批与执行（`tool-approval-request` / `tool-execution-started` / `tool-execution-finished`）、模型告警（3）、来源与文件（3）。

「durable 候选」只表示这条事件能产生 durable 效果，**不表示它原样落库**；落库的永远是条目。

## 事件 → 条目

| 来源 | 条目 |
| --- | --- |
| 用户提交消息 | `user`（`item_id` = 消息 id，恒 `complete`） |
| `text-end` | `text`（正文取结算后的内存 part；`status` 由 part.state 映射） |
| `reasoning-end` | `reasoning` |
| `tool-call` | `tool-call`（行状态恒 `complete`） |
| `tool-result` / `tool-error` / `tool-output-denied` / `tool-execution-finished` | `tool-result`（`outcome` = `output` / `error` / `denied`；必须先有 `tool-call`） |
| `turn-finished` | `turn-end`（`status` + `finishReason` / `reason` / `errorText`） |
| `turn-handoff` | `text`（作者是来源 Bot，接收方是目标 Bot） |
| 点停止 / 崩溃 | 未结算 part 补 `text` / `reasoning{interrupted}`；已有 `tool-call` 补 `tool-result{error}` |

其余事件（`start` / `finish` / `abort`、`step-*`、压缩、模型告警、来源、文件、`context-usage-changed`、`part-state-changed`）不产条目：它们要么只是运行期状态，要么当前没有渲染消费者。

## 唯一写入顺序

`apps/agent/src/core/session/itemRecorder.ts`：

```text
append(step, event)
  1. store.applySessionStreamEvent  → 内存视图（必须先于条目生成）
  2. live delta                     → frames.publishLive（只推增量）
  3. 结算事件                       → 从内存 part 生成条目 → items.appendItems（同事务分配 seq）
  4. frames.publish(toSessionItemFrame)
  5. store.advanceLastSeq           → 内存游标跟上最后一条
Turn 边界：
  beginTurn   → beginSessionTurn + items.beginTurn + 推送快照
  finishTurn  → 补未结算 part → items.finishTurn(turn-end) → 推送条目 → 内存收口 → 推送快照
  handoff     → 先 authorizeHandoff（Bot 发现 ACL），再写交接 text 条目
```

Turn/Step/压缩事实本身不再各写一行：Turn 的终态由 `turn-end` 条目表达，Step 与压缩只留在内存与 timeline 投影里。

## 硬约束

- 条目是唯一 durable 形态；客户端只折叠 `session-item` 帧，不消费「第二个 durable 事件流」。
- `seq` 只由 `SessionItemStore` 在插入成功时分配；宿主不得补号、不得跳号。
- 同一 `item_id` 重复写入是 no-op；不要用 UPDATE 改条目状态。
- 会话级状态（活动 Turn、用量、压缩）只走 `ConversationSnapshot`，不另发 durable 状态帧。
- 旧 wire envelope（`agentEventEnvelopeSchema`，含派生的 `run-state-changed`）不是事实目录，不进条目、不进帧。
- 新增条目种类或事件映射必须同时更新 `item.ts`、折叠函数与本文件。

相关：`state.md`（谁消费这些事实）、`projection.md`（怎么折叠）。
