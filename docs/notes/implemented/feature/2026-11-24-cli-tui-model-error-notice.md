# Note：CLI TUI 模型失败提示对齐 Claude Code

状态：已实施

## 问题

CLI transcript 的模型失败提示与 Claude Code 的视觉不一致：

- 错误正文直接顶格渲染成红色文本，没有 Claude 的 `  ⎿  ` 缩进行前缀，用户分不清它是上一轮回复的结果还是独立提示。
- 重试原因、HTTP 状态与倒计时由独立的 `RetryNotice` 渲染，位于错误文本上方，形成“先解释重试、再显示错误”的倒序结构。
- 网关返回的长错误全文铺满屏幕，且 Ctrl+O 只影响 transcript 内容，不能展开被截断的错误。
- `view.error` 与 `localError` 可能指向同一条失败，二者都渲染时会出现重复红字。

## 涉及范围

- 代码/模块：
  - `apps/cli/src/tui/transcript/ModelErrorNotice.tsx`：新的统一错误/重试块，替代 `RetryNotice.tsx`。
  - `apps/cli/src/tui/transcript/gutter.ts`：`RESPONSE_GUTTER` / `RESPONSE_GUTTER_WIDTH`，与工具结果行共用。
  - `apps/cli/src/tui/transcript/Transcript.tsx`：`TranscriptTail` 挂载 `ModelErrorNotice`，新增 `expanded`。
  - `apps/cli/src/tui/transcript/VirtualTranscript.tsx`：把 `transcriptMode` 传给尾部，并纳入 tail 测量键。
  - `apps/cli/src/tui/transcript/tool/toolLayout.ts`：`TOOL_RESULT_GUTTER` 复用同一 gutter 常量。
- UI 表面：仅 CLI transcript 尾部的错误与重试提示；不改变重试策略、run 终态、共享事件或桌面端错误卡片。
- 相关 Note：
  - [CLI 重试提示缺少原因与倒计时](../bug-fix/2026-11-16-cli-retry-notice-visibility.md)
  - [桌面端统一模型错误提示](./2026-10-19-unified-model-error-notice.md)

## 决定

- 错误提示按 Claude Code 的 `SystemAPIErrorMessage` 结构渲染：`  ⎿  ` gutter + 红色错误正文，下方同列缩进显示 dim 重试行。
- 重试原因、HTTP 状态、剩余秒数与 `attempt/maxRetries` 合并在 dim 行内，例如 `请求触发限流（HTTP 429）· 5 秒后重试 · 1/5`；原 `RetryNotice` 的三问信息全部保留，但不再是独立块。
- 错误正文超过 1000 字符时截断并追加 `…`，下一行显示 `(ctrl+o to expand)`；`expanded`（Ctrl+O 的详细 transcript）显示全文。
- `view.error` 与 `localError` 去重后按行拼接，同一条失败只显示一次。
- 倒计时以 `delayMs` 计算截止时间并每 250ms 刷新；组件以 `kind:attempt` 作为 key，新一次重试重新计时；`finished` 显示“重试已结束（attempt/maxRetries）”。
- 只有重试态而没有错误正文时，不绘制 `⎿` gutter，直接显示 dim 重试行，避免出现空 gutter。

## 影响表面

- 模型失败时 transcript 尾部呈现为 Claude 风格的红色 `⎿` 错误块；长错误默认折叠，Ctrl+O 展开全文。
- 重试信息位于错误正文下方，等待结束后若仍是 `finished` 态则明确显示重试已结束，不再假装仍在等待。
- 工具结果行与错误块共用 5 列 gutter，文本内容起始列一致。
- Ctrl+O 切换会改变尾部高度，虚拟列表按 `tailMeasureKey` 中的 `expanded` 重新测量。

## 曾考虑的替代方案

- **保留 `RetryNotice`，只在错误文本前加 `⎿`：** 舍弃。重试信息仍会出现在错误上方，且 Ctrl+O 展开语义需要跨两个组件协调。
- **错误作为 assistant 消息写入 transcript：** 舍弃。失败提示属于 run 终态而不是对话内容，写入条目会污染模型上下文并进入持久化。
- **不截断，完整显示错误：** 舍弃。网关错误可能上千字符且包含重复堆栈，会占满视口并掩盖重试行。
- **沿用 warning 色单独显示重试原因：** 舍弃。Claude 只用一种红色正文 + dim 辅助行；多一种颜色会让失败块看起来像两个不同层级的告警。

## 后果与防回退

- CLI 不再有 `RetryNotice` 组件；新增重试展示必须扩展 `ModelErrorNotice`，不得重新拆成两个块。
- `MAX_ERROR_CHARS`、`(ctrl+o to expand)` 文案与 `RESPONSE_GUTTER` 是视觉契约；修改时需要同步 `modelErrorNotice.test.tsx` 与压缩边界测试中的展开断言。
- 错误展开依赖 `TranscriptTail` 的 `expanded` 参数；`VirtualTranscript` 必须把 `transcriptMode` 同时传给渲染与测量键，否则展开后高度不更新。
- 倒计时状态仍以客户端收到重试事件为起点，只影响显示，不影响实际重试时刻。

## 验证

- `pnpm --filter @answra/cli exec vitest run test/tui/transcript test/tui/app`：17 个文件、91 项通过；覆盖 gutter 与红字、1000 字截断与展开、错误去重、重试原因/状态码/倒计时/次数、`finished` 文案，以及压缩边界与工具展示回归。
- `pnpm exec biome check apps/cli/src/tui/transcript apps/cli/test/tui/transcript`：通过。
- `apps/cli` typecheck 通过（`apps/agent` 同期存在与本变更无关的未提交改动，见提交说明）。

## 风险

- 错误正文来自 provider/网关原文，仍可能包含长 URL 或非中文内容；截断只控制长度，不做敏感信息清洗。
- 极窄终端下 `gutter + 重试行` 会折行，仍保持同列缩进，但可读性下降。
- `finished` 重试态会常驻到下一次 user 条目或成功 turn-end；这是既有 `view.error` 清理规则，本次未改变。
