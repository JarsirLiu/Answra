# 事件：durable / live 双通道

本文件回答：事实有哪些、走哪条通道、按什么顺序落地。

## 两条通道

| 通道 | 载体 | 内容 | 可靠性 | 读取口 |
| --- | --- | --- | --- | --- |
| durable | `SessionFrame`（`SESSION_FRAME_SCHEMA_VERSION = 2`，带 `seq`） | 36 种事实 | 断线按 `seq` 补齐，不许丢 | `readAfter` / `answra:conversation:read-frames` |
| live | `LiveFrame`（无 `seq`、无 `eventId`） | 4 种 delta：`text-delta`、`reasoning-delta`、`tool-input-delta`、`tool-output-delta` | 可丢，完整值由 durable 事件兜底 | 订阅推送，不参与重放 |

定义在 `packages/shared/src/schema/session/frame.ts`；payload 定义在 `packages/shared/src/schema/events.ts`。

## durable 事实的 12 组（共 36 种）

| 组 | 事件 | 数量 |
| --- | --- | --- |
| Turn | `turn-queued`、`turn-started`、`turn-finished`、`turn-handoff` | 4 |
| 压缩 | `compaction-started`、`compaction-finished`、`compaction-failed`、`compaction-aborted` | 4 |
| Step | `step-started`、`step-finished` | 2 |
| 上下文/部件 | `context-usage-changed`、`part-state-changed` | 2 |
| 生成生命周期 | `start`、`finish`、`abort` | 3 |
| 文本/推理边界 | `text-start`、`text-end`、`reasoning-start`、`reasoning-end` | 4 |
| 工具输入 | `tool-input-start`、`tool-input-end`、`tool-call` | 3 |
| 工具结果 | `tool-result`、`tool-error`、`tool-output-denied` | 3 |
| 工具执行/审批 | `tool-approval-request`、`tool-execution-started`、`tool-execution-finished` | 3 |
| 模型告警 | `model-warning-unsupported`、`model-warning-compatibility`、`model-warning-other` | 3 |
| 来源/文件 | `source-url`、`source-document`、`file` | 3 |
| 重试/终止 | `retry`、`error` | 2 |

## 唯一写入顺序

`apps/agent/src/core/session/sessionRuntimeJournal.ts:51`：

```text
append(sessionId, event, metadata)
  1. turn-handoff 先过 authorizeHandoff（Bot 发现 ACL，落库前拒绝越权交接）
  2. journal.append      → SessionEventEnvelope（唯一真相，append-only）
  3. frames.publish      → SessionFrame（同一事实 + 会话内连续 seq）
  4. bridge.apply        → transcript 快照 + advanceLastSeq（投影成功才推进游标）
  5. onDurableEvent      → usage 锚点、上下文状态（只读观察点，必须 fail-soft）
  6. onBoundary          → Turn/Step/压缩边界后的快照推送（不产生新事实）
```

## 硬约束

- transcript 写失败不回滚已追加的事实。
- `seq` 由 journal 分配，任何宿主都不得自行补号。
- 旧 wire envelope（`agentEventEnvelopeSchema`，含派生的 `run-state-changed`）只作迁移期传输，不进 journal、不进帧。
- 新增事件必须同时更新本文件的表与 `navigation.md` 的落层判断。

相关：`state.md`（谁消费这些事实）、`projection.md`（怎么折叠）。
