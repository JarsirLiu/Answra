# 状态：四层所有权

本文件回答：状态有几份、谁写、谁读、冲突怎么收敛。

## 四层

| 层 | 位置 | 职责 | 跨进程 |
| --- | --- | --- | --- |
| journal 事实 | `session_events`（SQLite / 内存） | 唯一真相，append-only | 是 |
| `SessionProjection` | `core/session/projection.ts` | 调度与恢复用的重算结果 | 否 |
| `ConversationSnapshot` | 各宿主读取 | 含 `activeTurnId`、`activeMessageId`、`lastSeq`；到达即整体替换 | 是 |
| `ConversationView` | 宿主内存 | 渲染专用，只由 fold 写 | 否 |

## 写点规则

- 活动槽位只由 `beginSessionTurn` 写入；`finishSessionTurn` 在 `turnId` 匹配时清除，不匹配不动。
- handoff 时切换 `authorAgentId`，不新建 Turn（同 Turn 内交接）。
- `lastSeq` 只由 `SessionTranscriptBridge.apply` 在投影成功后单调推进；journal 序号与 transcript 游标不得各写一份。
- 取消：排队 Turn 补写 `turn-finished`（aborted）；活动 Turn abort 后由执行器强制改判，不允许 UI 推断。
- snapshot 防 stale：`snapshot.lastSeq < view.lastSeq` 时丢弃；切换会话必须 reset。

## 恢复

顺序固定（`core/session/recoveryCoordinator.ts:56`）：

```text
recoverFacts(sessionId)     只写回崩溃遗留事实
  → restoreTranscript(...)  写回 assistant 消息与活动槽位
  → resumeQueued(...)       才允许 Scheduler 消费 queued Turn
```

顺序颠倒会让 Scheduler 早于 bridge 读 transcript，用户消息整条丢失。恢复只由会话所属领域懒触发，不做全局扫描。

## 反面清单

- 不要从 UI 反推「正在运行/已完成」；以 `turn-finished` 事实为准。
- 不要为了显示进度再存一份 `activeTurnId`；读 snapshot。
- 不要在 bridge 里改 Turn 状态或补 `seq`。

相关：`events.md`、`persistence.md`、`projection.md`。
