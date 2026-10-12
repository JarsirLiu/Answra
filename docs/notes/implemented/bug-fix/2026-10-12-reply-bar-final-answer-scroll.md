# Note：回复条终态答案滚动与活动标签

状态：已实施

## 问题

回复条把 text 活动的内部标签“回答”也画在正文前面。文本 delta 按模型速度增长，而 ticker 以固定低速追赶；进入文本阶段时只重置一次，终态没有重新播放完整答案的展示生命周期，窄回复条上容易让用户只看到答案开头或误以为不再滚动。思考正文的斜体样式也只依赖父元素继承，未明确约束正文节点。

## 涉及范围

- 代码/模块：`packages/ui/src/app/useConversationChat.ts`、`packages/ui/src/components/panels/ReplyActivityTicker.tsx`、`packages/ui/src/components/panels/ReplyBar.css`、对应 UI 测试。
- UI/进程/协议/持久化表面：回复条将标准 text/reasoning 活动投影为横向单行 ticker；不改模型协议和会话仓储。
- 相关 Note：[回复条展示标准消息活动](../feature/2026-10-12-reply-bar-stream-activities.md)。

## 根因

- text 活动标签作为 `<strong>` 和正文一起渲染，因此“回答”成为可见内容。
- 滚动仅跟随内容宽度变化；固定的 24px/s 低速在流式增长时落后，终态没有重播完整正文的明确阶段。
- ticker 初始化在 `ResizeObserver` 不存在时直接退出，连首次横向跟随都不会启动。
- 思考活动的斜体定义在父条目上，未直接声明正文 span 的字形。

## 修复

- text 活动不再投影可见标签；左侧静态图标及无障碍名称仍标识文本阶段。
- 文本生成期间缓慢跟随；检测到 run 从 pending 进入完成状态时，从答案开头以 100px/s 重播至末尾。没有 `ResizeObserver` 时仍启动动画，并在窗口 resize 时重新测量。
- 思考正文节点显式使用斜体。
- UI 回归测试覆盖文本阶段无可见“回答”标签，以及终态从开头继续横向滚动。

## 决定

滚动策略由独立的 `useHorizontalTickerScroll` hook 持有，与标准事件到活动条目的投影、ticker JSX 和颜色样式隔离。过程速度保持 140px/s，文本与终态答案统一使用 100px/s；结束时重播完整答案。UI 阶段只传入内容、文本/过程阶段和 pending 状态。

## 曾考虑的替代方案

- **让滚动速度匹配 token 到达速度：** provider 速度各异且答案会持续增长，无法提供稳定阅读速度；因此终态重播完整答案。
- **终态固定停在答案开头：** 长答案尾部无法被看到；因此终态有界地滚到完整文本末尾。

## 后果与防回退

- 文本阶段名称保留在图标的可访问名称中，但不作为正文前缀显示。
- 文本生成速度与最终浏览速度是两个阶段；不能依赖模型生成速度保证完整答案可见。
- ticker 在缺少 `ResizeObserver` 时仍需支持横向滚动。
- 思考条目的正文样式需显式保持斜体，避免依赖继承层级。

## 验证

- 回复条组件测试验证文本活动无可见“回答”标签、思考样式分类和完成后 ticker 向右滚动。
- `pnpm typecheck`、`pnpm test`、`pnpm notes:check`、`pnpm architecture:check`、相关文件 Biome 检查及 `git diff --check` 通过。
