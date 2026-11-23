# UI 投影

本文件回答：谁消费帧、怎么折叠、游标规则、工具怎么展示。

## 宿主消费

| 宿主 | 消费方式 | 现状 |
| --- | --- | --- |
| desktop renderer | `useConversationView` → `foldConversationFrame` / `overlayLiveFrame` | 已接；live 无批处理 |
| CLI TUI | `tui/app/viewStore.ts` → 同一 fold | 已接；live 16ms 批 + 队列上限 |
| remote host | 转发 `SessionFrame` 与 `read-frames` | 已接；不做投影 |
| mobile | Phase 0 骨架 | 未消费帧 |

共享实现：`packages/ui/src/app/conversationView.ts`（`applyConversationSnapshot`、`foldConversationFrame`、`overlayLiveFrame`）与 `packages/ui/src/tool-presentation`。

## 游标规则（两处一致）

- durable：帧只装 `session-item`；`seq === lastSeq + 1` 才折叠，`seq <= lastSeq` 丢弃；出现缺口置 resync，整段 `readAfter(lastSeq)` 重读。
- snapshot：用 `lastSeq` 防 stale；切换会话 reset；断链 abort 所有等待者。
- live：只覆盖当前消息的增量（含 `retry` / `error` 提示），不推进 `lastSeq`；正文与终态由 `text` / `turn-end` 条目定稿。
- 会话级状态（活动 Turn、用量、压缩）只从 snapshot 读；没有 durable 状态帧。

## 工具展示

`@answra/ui/tool-presentation` 是唯一适配层，CLI 与 desktop 共用，不各自解析工具输出；连续 read/search/list 折叠也在该层。

## 反面清单

- 不要在组件里自己算「运行中/失败」；用 `isToolRunning` / `isToolFailed`。
- 不要为每个 live delta 重建整棵视图（CLI 已用批处理，renderer 待补）。
- 不要复制第二套 fold；新增宿主应复用 `@answra/ui/conversation-view`。

相关：`events.md`、`state.md`、`tools.md`。
