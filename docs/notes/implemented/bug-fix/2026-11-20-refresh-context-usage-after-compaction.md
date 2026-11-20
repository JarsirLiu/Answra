# Note：压缩成功后刷新上下文用量

状态：已实施

## 问题

CLI 会话压缩成功后，底部 `ctx used/limit` 仍停留在压缩前由 provider 上报的值（例如 `212.3k/256k`），不会显示压缩后重建请求的实际占用；用户无法判断压缩是否生效，只能在下一轮模型请求完成后才看到新数字。

用户还观察到压缩时上下文会先降到约 50k，但压缩结束后状态行又回到旧值。经核对：

- 压缩路径本身会执行旧工具结果清理：`ContextPreparation.prepare()` 在 `compaction.status === "compacted"` 后用 `postCompactTarget` 强制调用 `pruneIfWorthwhile`，按压缩目标清理保留尾段中的白名单工具结果。约 50k 是重建后请求（system、工具 schema、summary、保留尾段）的真实估算。
- 但 `prepare()` 随后无条件用上一份 `usage` 覆盖 `usedTokens/source/updatedAt`，把刚算出的压缩后估算丢弃了。
- 即使 snapshot 携带压缩后估算，UI 的 `applyConversationSnapshot()` 在视图已有 provider usage 时也会拒绝任何 `estimate`，因此状态行继续显示旧值。
- 状态行此前只渲染 `source === "provider"`，压缩后估算没有可展示的来源标记。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/context/preparation.ts`：压缩成功后使用重建请求估算并标记来源。
  - `packages/shared/src/schema/status.ts`：`ContextUsage.source` 增加 `compaction`。
  - `packages/ui/src/app/conversationView.ts`：snapshot 选取规则与来源判断。
  - `packages/ui/src/app/contextUsage.ts`：可展示来源的单一判断。
  - `apps/cli/src/tui/chrome/StatusLine.tsx`、`apps/cli/src/tui/panels/StatusPanel.tsx`：显示压缩后估算。
- 测试：`apps/agent/test/core/context/preparation.test.ts`、`packages/ui/test/conversationView.test.ts`、`packages/ui/test/contextUsage.test.ts`、`apps/cli/test/tui/chrome/statusLine.test.tsx`。
- UI/进程/协议/持久化表面：CLI 状态行、`/status`、`ContextUsage` 持久化字段取值；不改变 Agent 事件、IPC 频道或数据库结构。
- 相关 Note：
  - [CLI 上下文用量按模型响应刷新](../bug-fix/2026-11-19-cli-context-usage-live-event.md)
  - [CLI 上下文用量分母改为模型上下文窗口](../feature/2026-11-20-cli-context-usage-window-denominator.md)
  - [256k 上下文预算与旧工具结果清理](../architecture/2026-11-13-context-budget-and-tool-result-clearing.md)

## 影响表面

| 表面 | 变化 |
| --- | --- |
| 手动 `/compact` | 成功后状态行和 `/status` 立即显示压缩后估算，而不是压缩前的 provider 值 |
| 自动压缩 | 压缩完成后推送的 snapshot 立即反映重建请求占用 |
| 下一轮模型响应 | 收到 `context-usage-changed` 后照旧切换为 provider 实测值 |
| 普通发送前 | 不变；仍保留上一次 provider 实测值，不显示发送前估算 |
| 压缩时清理 | 不变；压缩路径继续对重建后的保留尾段执行强制工具结果清理 |

## 根因

`ContextPreparation.prepare()` 在压缩分支已经算出重建请求的 `estimatedUsage`，但写回状态前会用 `previousUsage` 覆盖 `usedTokens/source/updatedAt`。即使 snapshot 携带新估算，`applyConversationSnapshot()` 也会在视图已有 provider usage 时拒绝 `estimate`，而状态行只接受 `provider`，三处叠加导致压缩后数字不更新。

## 修复

- 仅在 `compaction.status === "compacted"` 时把 usage 设为重建请求估算，并标记 `source: "compaction"`；失败、跳过、取消和普通准备路径继续保留上一份 provider usage。
- `applyConversationSnapshot()` 接受比当前视图更新的 `compaction` 估算，旧压缩 snapshot 或普通 `estimate` 仍不能覆盖 provider。
- CLI 状态行与 `/status` 通过统一的 `isReportedContextUsage()` 展示 `provider` 与 `compaction`，隐藏普通 `estimate`。

## 决定

- 压缩成功后，`ContextUsage` 使用 `prepare()` 对最终重建请求的估算：`estimateContextRequestTokens(final)`。该估算天然包含 system prompt、工具 schema、synthetic summary user message、保留的当前回合与其中的工具结果，不需要再把摘要输出 token 单独相加，否则会重复计数。
- 新增 `source: "compaction"` 表示“压缩后重建请求的估算”，与普通发送前 `estimate` 区分；provider 实测仍为 `provider`。
- 只有 `provider` 与 `compaction` 可作为状态行/`/status` 的展示值；普通 `estimate` 继续隐藏，避免发送前跳数。
- snapshot 合并规则：provider 仍总是覆盖；`compaction` 估算仅在 `updatedAt` 晚于当前视图时覆盖旧 provider；普通 `estimate` 不允许覆盖 provider。
- 下一轮 `context-usage-changed` 事件仍然把来源改为 `provider`，保持“provider 实测优先”的既有语义。

## 曾考虑的替代方案

- **压缩后仍保留旧 provider 用量，等下一轮响应再刷新：** 舍弃。压缩成功是用户可见的状态变化，继续显示旧值会让用户以为压缩没生效。
- **把摘要输出 token 单独加到系统上下文估算上：** 舍弃。摘要正文已经作为 synthetic user message 进入重建请求，再加一次会重复计数；当前摘要生成接口也只返回文本，没有可靠的实际输出用量。
- **直接把所有 `estimate` 都允许覆盖 provider：** 舍弃。会重新引入发送前估算跳数，违反[按模型响应刷新](../bug-fix/2026-11-19-cli-context-usage-live-event.md)的修复目标。
- **把压缩后估算的 `source` 写成 `provider`：** 舍弃。来源字段用于判断数据可信度和合并优先级，伪造来源会掩盖真实语义。
- **新增一条 `context-usage-changed` 事件携带压缩后估算：** 舍弃。该事件当前专指 provider 实测，且 `ContextPreparation` 不拥有事件写入职责；snapshot 已是准备阶段状态的正确出口。

## 后果与防回退

- 压缩成功后，`ctx` 会立即从旧值降到重建请求估算；随后模型 step 完成时再由 provider 用量校正。
- `source: "compaction"` 只表示一次可展示的估算，不代表 provider 已确认；不得据此跳过下一次 provider 刷新。
- 普通 `prepare()` 仍必须保留上一份 provider `usedTokens`；只有成功压缩（`status === "compacted"`）可以替换为重建估算。
- 压缩路径的强制工具结果清理不得移除；它是压缩后重建请求能降到目标附近的原因之一。
- 摘要 token 不得在重建请求估算之外重复相加。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/core/context/preparation.test.ts`：28 项通过，包括压缩成功后来源为 `compaction` 且用量等于重建请求估算。
- `pnpm --filter @answra/ui exec vitest run test/conversationView.test.ts test/contextUsage.test.ts`：28 项通过，包括较新的 `compaction` 估算覆盖旧 provider、较旧的压缩 snapshot 不覆盖新 provider。
- `pnpm --filter @answra/cli exec vitest run test/tui/chrome/statusLine.test.tsx test/tui/app/viewStore.test.ts test/tui/app/tui.compaction.test.tsx`：22 项通过，包括展示 `compaction` 并隐藏普通 `estimate`。
- `pnpm --filter @answra/shared typecheck`、`@answra/agent typecheck`、`@answra/ui typecheck`、`@answra/cli typecheck`：通过。
