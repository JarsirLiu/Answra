# Note：CLI 状态行压缩与输入框单字换行修复

状态：已实施

## 问题

CLI 底部状态行同时放 Bot/模型、`used/limit` token、工作区路径和阶段：窄终端下 token 对和目录互相挤压，模型名稍长就把 ctx 信息截掉；完整 token 对又太占宽度。输入框则出现“一个汉字单独占一行”的异常换行：光标单元格没有从可用列宽里扣除，且输入区宽度用窗口宽度减固定 chrome，和实际测量宽度不一致。

## 涉及范围

- `apps/cli/src/tui/chrome/StatusLine.tsx`：上下文改为百分比；固定/弹性收缩顺序。
- `apps/cli/src/tui/commands/StatusPanel.tsx`：`/status` 增加完整上下文用量行。
- `apps/cli/src/tui/app/App.tsx`：把 `state.view.contextUsage` 传给状态面板。
- `apps/cli/src/tui/composer/inputLayout.ts`：新增 `inputLayoutColumns()`，统一预留一个光标单元格。
- `apps/cli/src/tui/composer/PromptInput.tsx`：用 `useBoxMetrics` 测量输入区宽度，fallback 才用窗口宽度。
- 测试：`statusLine.test.tsx`（新增）、`tui.compaction.test.tsx`、`inputLayout.test.ts`。

## 决定

- 状态行只显示 `ctx {contextUsagePercent}%`，不显示 `45k/216k`；完整 `已用 / 上限` 放进 `/status`。
- Bot/模型可收缩并截断；ctx 固定 `flexShrink=0`；工作区占剩余列、`truncate-middle`；阶段固定 12 列。这样窄终端优先保留上下文百分比和阶段。
- `inputLayoutColumns(available)` 统一执行 `max(1, available - 1)`，把光标单元格纳入布局计算；`PromptInput` 优先使用 `useBoxMetrics` 的实测宽度，fallback 为 `windowColumns - 4`。
- 不改 shared 的 `ContextUsage` 契约，不改 Agent 事件；只改 CLI 展示与输入布局。

## 影响表面

- 用户可见：底部状态行从 token 对改为 `ctx N%`；工作区路径中间截断；`/status` 增加上下文完整用量。
- 输入行为：中文/emoji/长文本按实际测量宽度换行，光标不再额外挤出一列。
- 契约/持久化：不改 shared `ContextUsage`、Agent 事件、IPC 或持久化。

## 曾考虑的替代方案

- **状态行继续显示完整 token 对：** 舍弃。窄终端会挤压目录和阶段，且 Claude Code 的 footer 也只显示百分比。
- **让工作区路径优先展示：** 舍弃。用户更常需要判断上下文余量；完整路径可在 `/status` 查看。
- **只调大输入框 fallback 的固定扣减：** 舍弃。窗口宽度与实际输入区宽度受边框、指针、附件行影响，固定扣减会在不同终端宽度下继续错位；必须实测。
- **把所有状态行文字都设 `truncate`：** 舍弃。ctx 和阶段是判断运行状态的关键信息，不能让目录把它们挤掉。
- **给 `formatContextTokens` 增加 M 单位：** 本次不做。状态行已用百分比；`/status` 的 1M 显示留待单独格式化决策，避免扩大 shared UI 改动范围。

## 后果与防回退

- 状态行不得重新把 `used/limit` 放回主行；完整用量只能走 `/status`。
- 输入布局不得再使用 `value.length` 或窗口宽度直接估算光标列；`inputLayoutColumns` 是唯一预留光标的入口。
- `PromptInput` 的实测宽度只在 `useBoxMetrics` 有有效值时使用；fallback 必须保留，避免测试/非 TTY 环境无测量。
- 新增状态行固定项时必须明确 `flexShrink=0` 与宽度；新增可收缩项必须 `minWidth=0`，否则会重新出现换行或挤压。

## 验收标准

- 可观察结果：
  - 窄终端下状态行不换行，`ctx 21%` 和阶段可见，工作区中间截断。
  - `/status` 显示 `21%（45k / 216k）`；未准备请求时显示“尚未准备请求”。
  - 输入中文、emoji、长文本时不再出现单字独占一行；光标列与实际渲染一致。
- 自动化验证：
  - `apps/cli/test/tui/chrome/statusLine.test.tsx`。
  - `apps/cli/test/tui/app/tui.compaction.test.tsx`。
  - `apps/cli/test/tui/composer/inputLayout.test.ts`。
  - `pnpm --filter @answra/cli typecheck`、`pnpm --filter @answra/cli test`。
- 需要的实机验证：
  - Windows Terminal / VS Code 集成终端窄宽度下的状态行与中文输入换行。

## 验证

- 2026-11-16：`pnpm --filter @answra/cli typecheck` 通过。
- 2026-11-16：`pnpm --filter @answra/cli test` 通过 49 个测试文件、305 个测试；状态行、输入布局与 composer 用例包含在本轮全量运行中。
- 2026-11-16：`pnpm lint`、全仓 `pnpm typecheck`、`pnpm architecture:check`、`pnpm tokens:check`、`pnpm notes:check` 通过。
- 2026-11-16：全仓 `pnpm verify` 在 `packages/ui` 的 `FloatingBarApp.navigation.test.tsx` 超时失败；单独重跑该文件 9/9 通过。该文件不在本轮改动范围，属于并发负载下的既有 UI 抖动。
- 待完成：窄终端实机走查；未完成前不能把“所有终端宽度均不换行”当作已验收。

## 风险

- `truncate-middle` 在不同终端/xterm.js 实现下可能显示不同；需要实机确认。
- 实测宽度在某些测试环境不可用，fallback 仍可能与真实渲染差一列；已通过 `inputLayoutColumns` 统一预留降低风险。
- 阶段固定 12 列在极窄终端会占用较大比例；当前优先保留阶段和 ctx，必要时后续再做响应式隐藏。
