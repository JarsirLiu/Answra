# Note：回复与思考内容统一流式 Markdown

状态：已实施

## 问题

悬浮对话中的最终回答使用 Markdown，但解析器局限在答案组件内；思考块仍以纯文本段落渲染。思考和答案的格式行为不一致，流式增量也需要共享同一套安全解析规则。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/AicssConversationPrimitives.tsx`、`packages/ui/src/components/panels/ReplyConversationPopover.tsx` 及对应样式和测试。
- UI/进程/协议/持久化表面：悬浮回复面板中 SDK reasoning/text 活动的 Markdown 渲染。
- 相关 Note：[回复条悬浮展开实时对话](./2026-10-12-reply-bar-hover-conversation.md)。

## 决定

最终回答和思考正文共用 `react-markdown` 与 `remark-gfm`，按每次新增文本增量重新渲染；保留已有答案逐步 reveal、代码块复制和表格横向滚动。Markdown 不启用原始 HTML 插件，未完成的语法在流式过程中允许暂时显示为不完整结构。

## 影响表面

- 答案在流式 reveal 时解析 Markdown，完成后继续使用同一 renderer。
- 每个思考块在自身可折叠正文中解析 Markdown，不影响相邻答案块。
- 粗体、斜体、标题、列表、引用、行内代码、围栏代码块及 GFM 表格使用一致语义；长表格可以横向滚动。

## 曾考虑的替代方案

- **等模型完成后再解析 Markdown：** 舍弃；这会让流式期间仍显示原始标记，与实时阅读目标冲突。
- **为思考和答案分别维护解析组件：** 舍弃；两套规则会逐渐分歧，且答案已有可复用的 Markdown 依赖。

## 后果与防回退

- 流式中的未闭合语法可能暂时显示为普通文本或不完整块；后续增量到达后会重新解析为最终结构。
- Markdown 渲染继续使用 `react-markdown` 默认安全策略，不启用 raw HTML。
- 思考正文必须在自己的 reasoning 容器内渲染，折叠范围不得扩大到答案或其他活动。

## 验证

- UI 单测覆盖思考 Markdown 的粗体/行内代码和 GFM 列表解析；共享 primitive 由最终回答与思考块共同调用。
- `@answra/ui` 测试、类型检查、Biome 和 `pnpm notes:check`。
