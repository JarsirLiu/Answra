# Note：回复条完成态跑马灯停在最终文本回复

状态：已实施

## 问题

跑马灯（`ReplyActivityTicker` + `useHorizontalTickerScroll`）在流式期间会一直随内容滚到尾部，回复完成（`phase=done`、`replyPending=false`）后仍停在最尾部或继续跟滚。按对话契约，答案位于文本回复的最开头，用户此时最想读的就是答案，但尾部往往只剩摘要/思考尾巴，答案反而看不见。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/useHorizontalTickerScroll.ts`。
- UI/进程/协议/持久化表面：回复条活动跑马灯的滚动策略（仅 UI 表现层，不涉及 IPC 与持久化）。
- 相关 Note：[回复条完成态保留答案](2026-10-17-reply-bar-completion-holds-answer.md)、[回复条流式活动](2026-10-12-reply-bar-stream-activities.md)、[Markdown 公式渲染（KaTeX）](2026-10-17-markdown-katex-math-rendering.md)。

## 决定

在 `useHorizontalTickerScroll` 引入 `holdStartRef`：当滚动相位为 `text` 且 `pending` 为假（回复结束）时挂起自动跟滚，并利用既有的 `finishedText` / `enteringText` 把 `scrollLeft` 归零，让轨道停在文本回复开头。挂起覆盖三条重启路径：进行中的 rAF 循环（`step` 首行检查挂起标记）、resize / ResizeObserver 触发的 `followLatest`，以及每次渲染的兜底 `followLatest`。新一轮输出（`pending` 恢复真值或相位离开 `text`）时挂起自动解除，恢复跟滚。

## 影响表面

- 回复完成（done）后，跑马灯停在文本回复的第一屏（开头即答案），不再滚到尾部。
- 结束于非文本活动（如错误、工具结果）时不挂起，仍跟随展示尾部内容，错误可见性不受影响。
- 流式期间行为不变：继续自动跟滚到最新内容。
- `activities` 为空、处于发送条等其它状态时行为不变。

## 曾考虑的替代方案

- **完成后继续滚到尾部（原行为）：** 尾部不一定是答案，与“先看到答案”的预期冲突，因此改为停在开头。
- **完成后冻结在当前滚动位置：** 滚到哪算哪，用户看到的可能是思考尾段而非答案，无法保证契约语义，因此归零到开头。
- **让 `ReplyBar` / `ReplyBarWindowApp` 在 done 下显式传一个“停止滚动”新 prop：** 会把滚动策略知识扩散到窗口层，而 `pending=false` + 文本相位已经等价表达了“完成”，因此收敛在 hook 内部。
- **仅停止 rAF 不归零：** 停下时位置已在尾部，答案仍不可见，因此必须同时归零。

## 后果与防回退

- 挂起标记与滚动启动的三条路径（step、resize/observer、每渲染兜底）必须一致检查，漏掉任何一条都会在完成后把答案重新滚出可视区。
- “结束”判定复用 `phase === "text" && !pending`；若日后改动 `readReplyBarState` 里 done 强制 `replyPending=false` 的规则，需同步检查该 hook 的判定。
- 错误/工具尾部可见性依赖“非文本相位不挂起”，不得把挂起扩大到所有相位。

## 验证

- 新增 `packages/ui/test/useHorizontalTickerScroll.test.tsx`（手动 rAF + 可配置度量）：流式文本阶段跟随滚动到尾部、完成后归零并忽略 resize、done 直接挂载时停在开头、结束后非文本相位仍跟随。
- 运行 `pnpm notes:check`、`pnpm verify`。
