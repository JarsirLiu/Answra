# Note：CLI 流式输出时底部活动行闪烁

状态：已实施

## 问题

CLI TUI 在 AI 流式输出 Markdown 时，底部活动行（spinner 与 `esc to interrupt`）持续闪烁；工具调用阶段不明显，纯文本流式阶段最明显。Windows Terminal 与 conhost 均可复现。

## 涉及范围

- 代码/模块：`apps/cli/src/tui/app/App.tsx`、`apps/cli/src/tui/transcript/VirtualTranscript.tsx`
- 测试：`apps/cli/test/tui/app/tui.streaming.test.tsx`、`apps/cli/test/tui/transcript/tui.transcript.test.tsx`
- UI/进程/协议/持久化表面：CLI 全屏 transcript 布局、活动行与底部状态行
- 相关 Note：`docs/notes/implemented/architecture/2026-11-13-cli-tui-conversation-interaction-rebuild.md`

## 根因

两个问题叠加：

1. 活动行位于 `VirtualTranscript` 的 `footer` 内，属于滚动内容。流式文本每新增一行都会改变 transcript 总高度，footer 随内容移动，导致 spinner 行被反复重写。
2. App 根节点使用 `height={rows}`，正好填满 Ink 的 alternate screen。Ink 8.0.0 的 `shouldClearTerminalForFrame` 在 Windows 且帧为全屏时每帧执行 `cursorTo(0,0) + eraseDown`；实测原实现 30 个文本 delta 触发 30 次 spinner 重写，每帧以 `ESC[1;1H ESC[J` 开头。

## 决定

- 活动区（compaction 失败提示、上下文压缩提示、`Spinner`）从 `VirtualTranscript` 移出，固定在 transcript 之下、通知/输入框/状态行之上。`VirtualTranscript` 只保留末尾的 `TranscriptTail`（重试与错误提示）。
- Windows 上根布局高度改为 `rows - 1`，让 Ink 不再判定为全屏帧，从而走增量渲染；非 Windows 保持 `rows`，不牺牲整行空间。
- 不引入 Claude Code 的 Ink fork / ScrollBox。其 `src/ink` 约 100 个文件、18,000 行，且 `ScrollBox` 依赖自定义 DOM 字段与渲染器；为当前闪烁问题引入整套 fork 的维护成本远高于收益。

## 修复

`App.tsx` 把 activity 节点提取为固定布局的一部分，`VirtualTranscript.tsx` 删除 `footer` prop，将原 footer 虚拟项改为 `tail` 虚拟项并新增 `tailMeasureKey` 以保持测量缓存失效逻辑。Windows 帧高由 `WINDOWS_RESERVED_FRAME_ROWS = 1` 控制，非 Windows 直接使用终端行数。

## 曾考虑的替代方案

- **移植 Claude Code 的 ScrollBox + 自定义 alt-screen 渲染器。** 能获得固定 viewport、内部滚动和完整增量 diff，但需要同时移植 ~18k 行 Ink fork、DOM/屏幕缓冲/渲染器与测试 harness；当前闪烁只需避免整屏清除，投入与风险不成比例，因此不采用。
- **仅 patch Ink 的 `shouldClearTerminalForFrame` 去掉 Windows 全屏清除。** 改动小，但 stock Ink 的 cursor-relative diff 在满屏 Windows 上可能重新引入残影/滚动错位，缺少跨终端验证；先保留 `rows - 1`，不冒险改依赖。
- **关闭 alternate screen，退回原生 scrollback。** 不会触发全屏清除，但会丢失固定视口、内部滚动与现有选区/输入框布局，属于产品行为变化，否决。

## 后果与防回退

- Windows 底部保留一行未使用空间；这是当前 stock Ink 下避免整屏清除的最小代价。非 Windows 无此空行。
- 活动行固定在底部，滚动历史时 spinner 仍可见；transcript 视口高度在 spinner 出现/消失时变化一次，属于可接受的一次性布局变化。
- 回归测试必须继续断言流式分片中没有 `ESC[1;1H ESC[J`，且 spinner 重写次数受限；不要把 activity 再放回 `VirtualTranscript` 的滚动内容。
- 升级 Ink 或调整 `alternateScreen` / 根高度时，重新检查 Windows 全屏清除与底部空行行为。

## 验证

- `apps/cli/test/tui/app/tui.streaming.test.tsx`：10 个流式文本 delta，断言 spinner 文案重写次数 ≤4，并断言分片中没有 `ESC[1;1H ESC[J`。修复前同等场景为 30 次 spinner 重写并每帧整屏清除。
- `apps/cli/test/tui/transcript/tui.transcript.test.tsx` 的拖拽自动滚动用例改为选择实际注册过内容行的行号，避免视口高度变化后按压到空白行；断言仍要求选区起点每 tick 上移 2 行。
- `pnpm --filter @answra/cli test`：61 个测试文件、386 个测试通过。
- 需要在 Windows Terminal 与 conhost 手动观察流式 Markdown、窗口 resize、Ctrl+O transcript 切换与退出 alt screen。
