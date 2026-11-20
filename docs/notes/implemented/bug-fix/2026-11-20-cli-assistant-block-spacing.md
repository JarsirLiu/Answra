# Note：CLI assistant 内容块间距对称化

状态：已实施

## 问题

assistant 消息里，工具调用结束后紧跟文本时没有空行，视觉上挤在工具结果行下面；而文本后接工具时却有一行空行。同一消息内块与块的间距不对称，与 Claude Code 的呈现不一致。

## 涉及范围

- 代码/模块：`apps/cli/src/tui/transcript/MessageRow.tsx`、`apps/cli/src/tui/transcript/virtualLayout.ts`
- UI/进程/协议/持久化表面：仅 CLI transcript 的渲染行距与虚拟高度估算，不涉及消息结构、Agent 事件或持久化
- 相关 Note：`docs/notes/implemented/feature/2026-11-16-cli-image-input.md`（transcript 图片行，已移除附件行）

## 根因

间距分别落在两个层级：assistant 消息容器固定 `marginTop={1}`，工具组件 `ToolCall` / `ToolGroupRow` 自身再带 `marginTop={1}`，而文本与 reasoning 块没有上边距。于是文本→工具由工具补上间距，工具→文本没有补，形成单向间距。之前没有按“每个内容块一行空行”设计过间距归属。

Claude Code 的做法是按块给间距：`AssistantTextMessage`、`AssistantToolUseMessage`、`AssistantThinkingMessage` 都以 `marginTop={addMargin ? 1 : 0}` 渲染，`addMargin` 来自消息行（transcript 元数据头部展开时为 0）；消息容器本身不加间距。这样同一 assistant 消息内任意两个块之间都是一行空行，首块与上一条消息之间也是一行。

## 决定

- 对齐 Claude 的按块间距模型：assistant 消息容器不再加 `marginTop`；文本、reasoning、工具、工具组各自承担首行上边距，工具组展开后的嵌套工具仍为 0。
- 保留 user 消息的容器 `marginTop={1}`，用户块与 assistant 块之间仍是一行空行。
- 虚拟高度估算同步改为“每个渲染块 = 1 行间距 + 内容高度”，避免滚动时估算与实际测量长期偏差；这也修正了原先工具块间距未计入估算的问题。
- 不引入 `addMargin` 这类由消息行传入的开关；CLI 当前没有 transcript 元数据头部，所有 assistant 块恒定一行间距。

## 修复

- `MessageRow`：assistant 容器去掉 `marginTop`；fallback 文本、文本块、reasoning 块包一层 `marginTop={1}`；工具与工具组保留自身间距。
- `virtualLayout`：assistant 高度从固定基数 1 改为逐块累加 `1 + 内容高度`，reasoning 折叠与展开、工具组折叠与展开都按该规则计算。
- 新增 `messageRow.test.tsx` 断言文本、工具结果、后续文本之间的空行位置；`virtualLayout.test.ts` 新增多块消息的间距断言。

## 曾考虑的替代方案

- **只给工具后的文本补 `marginTop`。** 需要判断“前一个块是否为工具”，间距归属继续散落在条件分支里，reasoning 与工具组组合仍会漏。
- **保留消息容器间距，仅统一工具与文本的边距。** 首块与后续块的间距仍来自不同层，消息以工具开头时会出现两条空行。
- **在 Markdown 或工具内容里输出空行。** 会把纯展示间距写进内容，影响复制文本与高度测量。

## 后果与防回退

- assistant 消息内所有顶层块之间、以及与上一条消息之间都是一行空行；展开工具组时内部工具行仍紧凑。
- 少量只包含被隐藏 reasoning 的消息在非 transcript 模式下仍按估算占位，这是既有的 `showReasoning` 与估算签名不一致问题，本次未扩大处理。
- 若未来加入消息级元数据头部，需要按 Claude 的 `addMargin` 思路关闭首块间距，而不是再改回容器间距。

## 验证

- `pnpm --filter @answra/cli exec vitest run test/tui/transcript`：49 项通过，含新增间距断言。
- `pnpm --filter @answra/cli typecheck`：通过。
- `pnpm exec biome check`：通过。
- 需在 Windows Terminal 实机确认工具结果与后续文本之间出现一行空行。
