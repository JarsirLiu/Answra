# 状态：四层所有权

本文件回答：状态有几份、谁写、谁读、冲突怎么收敛。

## 四层

| 层 | 位置 | 职责 | 跨进程 |
| --- | --- | --- | --- |
| 条目事实 | `session_items`（SQLite / 内存） | 唯一真相，append-only；`seq` 由此分配 | 是 |
| Turn 投影 | `core/session/sessionTurns.ts`（`projectSessionTurns`） | 调度与恢复用的重算结果（队列、活动 Turn、pending） | 否 |
| `ConversationSnapshot` | 各宿主读取 | 含 `activeTurnId`、`activeMessageId`、`lastSeq`；到达即整体替换 | 是 |
| `ConversationView` | 宿主内存 | 渲染专用，只由 fold 写 | 否 |

## 写点规则

- 活动槽位：`open_turn_id` 只由 `SessionItemStore.beginTurn` 置位；`finishTurn` 与 `turn-end` 同事务清空；提交/排队不置位。
- `lastSeq` 恒为 `next_seq - 1`；`seq` 只在插入成功时前进；宿主侧 `lastSeq` 由 `itemRecorder.publishItems` 用最后一条条目推进，不另算。
- handoff 只切换 `authorAgentId`，不新建 Turn；交接消息本身是一条 `text` 条目（author = 来源，audience = 目标）。
- 取消：排队 Turn 只补 `turn-end{interrupted, cancelled}`；活动 Turn abort 后由执行器强制改判，不允许 UI 推断。
- 会话级状态只在 Turn/Step 边界随 snapshot 推送；不新增 durable 状态帧。
- snapshot 防 stale：`snapshot.lastSeq < view.lastSeq` 时丢弃；切换会话必须 reset。

## 恢复

顺序固定（`core/session/recoveryCoordinator.ts`）：

```text
recoverFacts(sessionId)     只写回崩溃遗留的收口条目
  → refreshTranscript(...)  用条目重建消息视图与活动槽位
  → resumeQueued(...)       才允许 Scheduler 消费 queued Turn
```

`recoverFacts` 由纯函数 `planSessionRecovery` 给出计划：有内容无 `turn-end` 的补 `tool-result{error}` + `turn-end{interrupted, process-exit}`；只有 `user` 条目的重新入队。顺序颠倒会让 Scheduler 早于视图重建读 transcript，用户消息整条丢失。恢复只由会话所属领域懒触发，不做全局扫描。

## 反面清单

- 不要从 UI 反推「正在运行/已完成」；以 `turn-end` 条目为准。
- 不要为了显示进度再存一份 `activeTurnId`；读 snapshot 或 `open_turn_id`。
- 不要在折叠里补 `seq`、补条目或推测缺失状态。

相关：`events.md`、`persistence.md`、`projection.md`。
