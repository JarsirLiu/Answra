# Note：保留 UI 中较新的 provider context usage

状态：已实施

## 问题

模型 step 的 provider 实测 context usage 通过实时事件更新 UI；并行恢复或刷新流程还可能返回较旧的 snapshot，其中只有请求准备阶段的估算值。直接用 snapshot 覆盖会让刚刷新的真实值退回估算值，造成 ctx 显示跳变。

## 根因

`applyConversationSnapshot()` 原样使用 snapshot 的 `contextUsage`。snapshot revision 只约束 transcript/event 的恢复游标，不表达 usage 来源的新旧程度；因此较旧估算在异步恢复完成时可能覆盖已经由 provider 事件更新的值。

## 涉及范围

- 代码：`packages/ui/src/app/conversationView.ts` 的 snapshot 投影。
- 测试：`packages/ui/test/conversationView.test.ts`。
- 协议、持久化与 Agent usage 来源：不变。

## 决定

- 当前 view 已有 provider usage、而 snapshot 只有 estimate 时，保留 view 中的 provider usage。
- snapshot 提供 provider usage 时接受其值；view 尚无 provider usage 时也正常从 snapshot 初始化。
- 只在 UI 投影层选择展示值，不改变 snapshot/event 的权威来源，也不在发送消息时推算或刷新 provider usage。

## 修复

- 应用 snapshot 时，保留 view 中已有的 provider usage，除非 snapshot 自身也提供 provider usage。
- 覆盖 provider usage、从 snapshot 初始化 estimate 的路径均有回归测试。

## 曾考虑的替代方案

- **丢弃所有迟到 snapshot：** snapshot 还承载消息、运行状态等恢复数据，整体丢弃会丢失无关状态，因此不采用。
- **改变 provider usage 的事件/快照顺序或协议：** 需要跨进程修改且不能消除已有异步恢复请求的覆盖问题；当前投影只需要依据 `source` 保住更可信的 usage，因此不扩大协议范围。

## 后果与防回退

- 恢复快照不会把已经到达的 provider 实测值退回估算值。
- 后续增加 usage 来源或 freshness 语义时，需更新此处投影规则与测试，不能以普通 snapshot 覆盖更可信的实测数据。

## 验证

- `pnpm --filter @answra/ui exec vitest run test/conversationView.test.ts`：通过。
- `pnpm --filter @answra/ui typecheck`、`pnpm exec biome check packages/ui/src/app/conversationView.ts packages/ui/test/conversationView.test.ts`、`pnpm notes:check`：通过。
