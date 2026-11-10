# Note：Markdown 表格与代码块滚动条过粗

状态：已实施

## 问题

AI 正文中的 Markdown 表格一旦横向溢出，底部会出现 Windows/Chromium 原生滚动条约 15px，带两端箭头和浅灰轨道，视觉上比表格本身还抢眼；代码块和长输出也有同类风险。用户要求：所有滚动条只要必须存在，就必须极细。

## 涉及范围

- 代码/模块：
  - `packages/ui/src/styles/base.css`：全局滚动条唯一定义。
  - `packages/ui/src/components/chat/conversation.css`
  - `packages/ui/src/components/chat/MessageStream.module.css`
  - `packages/ui/src/components/tool-call/toolCallContent.module.css`
  - `packages/ui/src/components/tool-call/renderers/edit.module.css`
  - `packages/ui/src/components/panels/workspace/WorkspacePanel.css`
  - `packages/ui/src/components/panels/message-actions/MessageActions.module.css`
  - `packages/ui/src/components/panels/ReplyConversationPopover.css`
  - `packages/ui/test/TextResponse.test.tsx`
  - `packages/ui/test/themeCss.test.ts`
- UI/进程/协议/持久化表面：只改 renderer 的滚动条视觉与 CSS 守卫；不新增 IPC、不改 transcript。

## 根因

- `.tableScroll` 与 `.prose pre` 只声明 `overflow-x: auto`，没有滚动条样式，直接落回 Chromium 在 Windows 上的原生粗滚动条。
- 全局层没有统一滚动条规则，各组件各自写 4px 或 6px，前者不断复制，后者比对话区更粗。
- `MessageActions` 的 `.pickerScroll` 和 `ReplyConversationPopover` 使用了 `scrollbar-width: thin` + `scrollbar-color`。Chromium 一旦看到非 `auto` 的标准 `scrollbar-width`，就会忽略 `::-webkit-scrollbar` 的 4px 细条规则，实际仍回落到系统粗条。

## 修复

- 在 `styles/base.css` 增加全局 `::-webkit-scrollbar` 规则：宽高 4px、透明轨道/角落、`var(--glass-line)` 圆条、hover 变为 `var(--muted)`，并隐藏 `::-webkit-scrollbar-button` 的箭头。
- 不声明 `scrollbar-width` / `scrollbar-color`；需要隐藏滚动条的容器继续用自身的 `display: none` / `scrollbar-width: none` 覆盖。
- 删除对话流、消息视口、工具面板、Edit diff 中重复的 4px 规则，统一继承全局。
- 删除工作区预览的 6px 覆盖，统一为 4px。
- 删除 `pickerScroll` 与 `ReplyConversationPopover` 的标准 `thin` / `scrollbar-color`，恢复 WebKit 细条规则生效。

## 决定

- 滚动条只有一套全局尺寸：4px；任何滚动容器不得再定义 6px、8px 或系统 `thin`。
- 所有可见滚动条都保留可抓取能力，不为了“细”而全部隐藏；只有原本就设计为无滚动条的窄条、标签栏和活动视口继续隐藏。
- 滚动条颜色继续走 `--glass-line` / `--muted`，不引入第二套灰色。
- Markdown 表格与代码块不靠折行消除横向滚动；保持 `overflow-x: auto`，由极细滚动条承载。

## 曾考虑的替代方案

- **只给 `.tableScroll` 加 4px：** 舍弃，只修截图里的表格，代码块、工具输出和工作区仍会出现 6px 或系统粗条。
- **使用 `scrollbar-width: thin` 统一：** 舍弃，Chromium 下实际宽度仍接近系统条，而且会让 `::-webkit-scrollbar` 失效；无法满足“极细”。
- **改成 2px：** 舍弃，视觉更细但鼠标命中面积过小，长文档里几乎无法拖动。
- **全部 `scrollbar-width: none` 隐藏：** 舍弃，横向溢出的表格和代码块会失去可发现性，用户不知道还能横向滚动。
- **用 JS 做自动淡出/自定义滚动条：** 舍弃，为纯视觉问题引入滚动同步与无障碍成本；原生极细滚动条已足够。

## 验证

- `TextResponse` 新增 Markdown 结构用例：GFM 表格包在 `.tableScroll` 中，fenced code block 仍渲染语言标签与代码正文。
- `themeCss` 新增守卫：`base.css` 必须存在 4px 全局滚动条、隐藏箭头、`--glass-line` 拇指；全仓禁止 `scrollbar-width: thin`；所有 `::-webkit-scrollbar` 宽高只能是 4px 或 0。
- UI 全量测试、`tsc --noEmit`、`pnpm lint`、`pnpm verify` 作为提交门禁。

## 后果与防回退

- Markdown 表格、代码块、对话流、工具输出和工作区共享同一条 4px 滚动条，不再随组件变化。
- 新增滚动容器默认继承全局，不需要也不允许再写尺寸；只有“确实不该出现滚动条”的容器可以隐藏。
- 若未来在 Electron 升级后发现 WebKit 伪元素失效，必须先验证 Chromium 标准属性，不能直接回退到 `scrollbar-width: thin`。
- 回归守卫为 `TextResponse.test.tsx` 的 Markdown 结构用例与 `themeCss.test.ts` 的滚动条尺寸/标准属性检查。
