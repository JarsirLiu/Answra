# Note：CLI 状态行显示具体上下文 token 用量

状态：已实施

## 问题

CLI TUI 底部状态行只显示 `ctx 21%`。百分比丢掉了绝对量信息：用户无法判断当前是 4.5 万 token 还是 20 万 token，也无法和目标模型的实际容量或压缩阈值对照；而 `/status` 面板里本来就同时显示百分比与 `used / inputLimit`，两处信息量不一致。

此前的百分比形式是为避免 `45k/216k` 在窄终端被截断而做的取舍，但状态行的 Bot/模型段已经可收缩、工作区段会 `truncate-middle`，`ctx` 段本身是固定宽度，不存在被截断的风险。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/chrome/StatusLine.tsx`：状态行上下文用量文案。
  - `apps/cli/test/tui/chrome/statusLine.test.tsx`：状态行渲染断言。
  - `apps/cli/test/tui/app/tui.compaction.test.tsx`：App 级状态行断言。
- UI/进程/协议/持久化表面：只改 CLI TUI 状态行文案；不改上下文预算、压缩策略、事件或远程协议。
- 不涉及：新增依赖、`@answra/ui` 的格式化实现、桌面端状态展示。

## 决定

- 状态行显示 `ctx <已用>/<inputLimit>`，例如 `ctx 45k/216k`，复用 `@answra/ui/conversation-view` 已有的 `formatContextTokens`；不在 CLI 复制 token 格式化规则。
- 分母用 `inputLimit`（压缩检查上限，默认 216k）而不是 `contextWindow`（模型窗口，默认 256k），与 `/status` 面板保持同一比较基准；用户需要窗口总量时看 `/status`。
- 移除状态行里的 `contextUsagePercent` 引用；百分比只保留在 `/status` 面板。

## 曾考虑的替代方案

- **保留百分比、把绝对量放进 hover/展开态：** 舍弃。终端没有 hover，展开态又要新增交互；一行固定文本就能表达。
- **`45k/216k (21%)` 同时显示：** 舍弃。状态行宽度有限，百分比在脱离分母后信息量最低，且 `/status` 已提供。
- **分母改用 `contextWindow`（256k）：** 舍弃。压缩在 216k 触发，用 256k 作分母会让“接近压缩”这一关键信号失真。
- **在 CLI 内实现一套 token 格式化：** 舍弃。`formatContextTokens` 已被 `/status` 使用，复制会产生两套 `k` 精度规则。

## 后果与防回退

- `ctx` 段宽约 12 列，比百分比形式宽约 4 列；窄终端下压缩的是工作区路径，不是 `ctx` 段。`ctx` 段必须保持 `flexShrink={0}`。
- 状态行不得再退回百分比；百分比只在 `/status` 面板出现。
- 格式化必须继续走 `formatContextTokens`，不得内联 `toFixed` 或自行加单位。

## 验证

- `npx vitest run test/tui/app/tui.compaction.test.tsx test/tui/chrome/statusLine.test.tsx`：2 个文件全部通过，断言 `ctx 45k/216k` 且不再出现 `21%`。
- `npx tsc --noEmit`：exit 0。
