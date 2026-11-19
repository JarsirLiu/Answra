# Note：CLI 排队 prompt 可见性

状态：已实施

## 问题

运行中的 CLI 只显示 `N queued`，用户按 Enter 后看不到自己刚提交的正文。长回合或工具循环中无法确认消息是否被接受，容易重复提交或误以为输入丢失。

## 涉及范围

- 代码/模块：`apps/cli/src/tui/runController.ts`、`apps/cli/src/tui/app/viewStore.ts`、`apps/cli/src/tui/app/App.tsx`、`apps/cli/src/tui/transcript/QueuedPrompts.tsx`
- UI 表面：运行中的本地输入队列投影与 spinner 计数
- 相关 Note：[Conversation 输入队列与远程 Host 顺序语义](../architecture/2026-11-14-conversation-input-queue-and-remote-host-ordering.md)

## 决定

保留“完整用户回合结束后启动下一条”的 host 队列语义，只在 TUI 增加明确的本地投影：排队正文可见、状态可区分、发送接受后由正常 transcript 接管。队列事实源仍是 `TuiRunController` 的进程内数组，`queuedPrompts` 只是 view store 的单向投影。

## 根因

`TuiRunController` 的 `QueuedTurn` 只保存 `{ text, images }`，同步到 view store 的只有 `queue.length`。排队正文没有进入任何 UI 投影，因此用户只看到数量。原 `drain()` 在发送前就 `shift()`，即使补了临时展示也会在 `session.send` 等待期间立即消失。

## 修复

- 队列项增加本地 `id`；`SessionRuntime` 记录 `sendingId`，用来区分“等待当前回合”和“正在被 host 接受”。
- `TuiState` 增加只读 `queuedPrompts` 投影；`queued` 数量由 `status === "queued"` 派生，避免 count 与正文两套事实源。
- `App` 在 transcript 与活动行之间渲染 `QueuedPrompts`：排队项标记“已排队 · 当前回合结束后发送”，发送中的项标记“正在发送…”，并显示图片数量。
- 发送前保留首项，直到 `session.send()` 返回后才从队列移除；移除前比较对象身份，避免取消清空队列后又误删新提交的 prompt。
- 该投影不写入 `view.messages`、不创建 assistant 占位、不改变“完整用户回合结束后按 FIFO 启动下一项”的既有语义。

## 曾考虑的替代方案

- **把排队项伪造成 transcript user 消息：** 舍弃。排队消息尚未进入模型上下文，提前写入会让 UI 和持久化伪装成已开始，违反既有队列 Note 的状态边界。
- **只放大 spinner 的 queued 数量：** 舍弃。用户仍无法确认正文，不能解决重复提交和输入丢失的误判。
- **改为模型步级 steer：** 本次舍弃。需要在活动 run 内把用户消息注入下一步模型请求，并扩展 transcript 顺序与事件契约，属于独立能力，不能用修改 drain 条件冒充。

## 验收标准

- 运行中提交 prompt 后，正文立即出现在活动行上方，并明确标记为排队；发送被接受后，本地投影消失，正文由正常 transcript 事件接管。
- 取消当前 run 会同时清除排队投影；后台会话的队列不会污染前台视图。
- 普通即时提交、多会话切换和图片-only 排队不丢失 `images`。

## 风险

- 本地投影与 host snapshot 之间存在极短的时间差；发送被接受后依靠 snapshot/event 接管，不把本地数组当会话顺序权威。
- 队列仍只存在于进程内，退出即丢；本变更不提供跨重启恢复。
- 这是可见性修复，不改变“当前完整回合结束才发送下一条”的等待时间。

## 后果与防回退

`queuedPrompts` 是 TUI 展示投影，不是 transcript 或队列事实源；不得用它驱动模型上下文、持久化或 assistant 占位。后续若实现 step 级 steer，必须单独新增 Note 与契约，并保留“排队/已开始”的可见区分。

## 验证

- `apps/cli/test/tui/app/viewStore.test.ts`：queued 数量由 prompt 状态派生，reset 清空投影。
- `apps/cli/test/tui/runController.test.ts`：host 接受期间保持 `sending`；取消清空在途发送后新提交的 prompt 不被误删。
- `apps/cli/test/tui/runTui.test.ts`：运行中提交显示排队正文，接受后清空本地投影，取消清空队列。
- `apps/cli/test/tui/transcript/queuedPrompts.test.tsx`：排队/发送/空队列三种渲染状态与图片数量。
- 目标测试 53 项通过；`pnpm --filter @answra/cli test` 全量 395 项通过；`pnpm --filter @answra/cli typecheck`、`pnpm lint`、`pnpm notes:check` 通过。
- `pnpm verify` 的 UI 分片在并行全量下有一次 `FloatingBarApp.navigation.test.tsx` 超时；该文件单独重跑 9 项通过，与本次 CLI 改动无交集。工作区另有 `packages/ui/src/app/conversationView.ts` 的并行修改。
