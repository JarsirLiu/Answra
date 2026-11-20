# Note：CLI 上下文用量分母改为模型上下文窗口

状态：已实施

## 问题

CLI 底部状态行显示 `ctx 212.3k/216k`，`/status` 面板也使用同一分母。用户把 `216k` 当成“上下文上限”，但实际配置的模型窗口是 `256k`；用户想要的是“真实输入 token / 模型实际上下文窗口”，而不是“真实输入 token / Answra 内部输入硬上限”。

`216k` 来自 `ContextUsage.inputLimit = contextWindow - maxOutputTokens - safetyTokens - fixedOverheadTokens`（256k − 20k − 12k − 8k）。它只是发送前压缩/裁剪检查使用的内部硬上限，不是 provider 的模型窗口，也不是 172k 工具结果清理阈值。

同一会话中用户还观察到 172k 的清理阈值没有触发，并看到分子与 provider 后台的首个输入数字不一致。经核对：

- `usedTokens` 直接取 provider `usage.inputTokens`，该值已包含 cache read、cache write 和未命中输入；后台 `11,371 + 163,244 + 37,672 = 212,287` 与状态行 `212.3k` 一致，分子无需修改。
- 172k 是旧工具结果清理触发点，不是摘要压缩触发点；摘要压缩在 `compactAt = 216k`。清理还要求存在白名单内（`read`/`grep`/`run_command`）的旧工具结果，且净节省达到 `132k` 才接受前缀变化；没有足够可清结果时本来就不会清理。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/chrome/StatusLine.tsx`：状态行 `ctx used/limit` 的分母。
  - `apps/cli/src/tui/panels/StatusPanel.tsx`：`/status` 面板的百分比与 `used / limit`。
  - `packages/ui/src/app/contextUsage.ts`：`contextUsagePercent()` 的比较基准。
  - `packages/ui/test/contextUsage.test.ts`：百分比基准回归测试。
  - `apps/cli/test/tui/chrome/statusLine.test.tsx`、`apps/cli/test/tui/app/tui.compaction.test.tsx`：分母断言。
- UI/进程/协议/持久化表面：CLI 状态行与 `/status` 文案；`ContextUsage` 结构、事件与持久化不变。
- 相关 Note：
  - [CLI 状态行显示具体上下文 token 用量](../feature/2026-11-18-cli-status-line-context-tokens.md)
  - [CLI 上下文用量按模型响应刷新](../bug-fix/2026-11-19-cli-context-usage-live-event.md)
  - [256k 上下文预算与旧工具结果清理](../architecture/2026-11-13-context-budget-and-tool-result-clearing.md)

## 影响表面

| 表面 | 变化 |
| --- | --- |
| CLI TUI 状态行 | `ctx 212.3k/216k` 改为 `ctx 212.3k/256k`，分母使用 `contextWindow` |
| `/status` 面板 | 百分比与 `used / window` 都以 `contextWindow` 为基准 |
| 分子 | 普通回合不变，仍是 provider 报告的 `inputTokens`（含缓存命中与未命中）；压缩成功后临时使用重建请求估算 |
| 协议/持久化 | 无变化 |

## 决定

- 所有面向用户的上下文用量都显示 `usedTokens / contextWindow`，分子是 provider 最近一次请求的真实输入 token，或压缩成功后重建请求的估算；分母是模型端点声明的实际上下文窗口。
- `contextUsagePercent()` 改为 `usedTokens / contextWindow`，与显示分母保持一致。
- `inputLimit`、`compactAt`、`pruneAt` 等内部预算字段继续保留在 `ContextUsage` 中供诊断和压缩逻辑使用，但不再冒充“上下文上限”展示。
- 不改压缩阈值、清理阈值、工具清理策略或 provider usage 语义。

## 曾考虑的替代方案

- **继续用 `inputLimit` 作分母：** 舍弃。它让用户以为模型只有 216k 上下文，与实际配置的 256k 不符；压缩/清理阈值属于实现细节，不应成为用量分母。
- **状态行显示 256k，`/status` 保留 216k：** 舍弃。两个界面比较基准不同，会制造新的“数字对不上”问题。
- **同时显示 `212.3k/256k` 与 `压缩 216k`：** 舍弃。状态行宽度有限，且用户已明确把阈值数字误读成上限；阈值只在诊断需要时由代码内部使用。
- **把分子改成“非缓存输入 token”：** 舍弃。上下文占用就是模型实际读入的全部输入，缓存命中仍占窗口；排除缓存会低估真实占用。

## 后果与防回退

- 用户看到的百分比会变小（同一 212.3k 从约 98% 变为约 83%），这是分母改为真实窗口的结果，不代表压缩触发点被上调。
- 状态行分母不得再退回 `inputLimit`；`/status` 必须与状态行使用同一 `contextWindow` 基准。
- 百分比必须继续走 `contextUsagePercent()`，不得在 CLI 内另算一套分母。
- 172k 清理与 216k 压缩的语义不变；怀疑清理未触发时先检查是否存在可清理旧工具结果和 132k 净节省门槛，而不是修改分母。

## 验证

- `pnpm --filter @answra/cli exec vitest run test/tui/chrome/statusLine.test.tsx test/tui/app/tui.compaction.test.tsx`：7 项通过，断言 `ctx 45k/256k`。
- `pnpm --filter @answra/ui exec vitest run test/contextUsage.test.ts`：2 项通过，断言 `212.3k / 256k = 83%` 且百分比封顶 100。
