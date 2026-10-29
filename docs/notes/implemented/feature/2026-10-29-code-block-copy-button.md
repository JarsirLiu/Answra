# Note：答题代码块提供一键复制

状态：已实施

## 问题

截图答题和普通对话的 AI 回复会把代码放在 Markdown fenced code block 中，但代码块只有语言标签，用户需要手动选中代码才能复制，答题时尤其影响操作速度。

## 涉及范围

- 代码/模块：`packages/ui/src/components/chat/TextResponse.tsx`、`packages/ui/src/components/chat/TextResponse.module.css`
- 测试：`packages/ui/test/TextResponse.test.tsx`
- UI 表面：AI 正文中的 fenced code block

## 决定

在每个代码块的顶部工具栏保留语言标签，并增加右侧复制按钮。按钮将当前代码文本（去除 Markdown 结尾换行）写入浏览器剪贴板，成功或剪贴板不可用时都显示短暂的“已复制”状态，与消息操作条保持一致；按钮使用 `aria-label` 和 `title` 提供可访问名称与提示。

## 影响表面

代码块仍使用现有主题令牌和排版，新增按钮只占用代码块顶部工具栏的右侧空间，不改变代码正文的滚动行为。行内代码不显示复制按钮。

## 曾考虑的替代方案

- **复用消息底部的整条回复复制按钮：** 舍弃。用户需要复制某一段代码时仍要复制整条回答，操作目标不够直接。
- **把复制按钮放在代码正文底部：** 舍弃。代码较长时按钮会离开用户视线，和用户提出的右上角操作位置不一致。
- **为代码块新增独立剪贴板 IPC：** 舍弃。renderer 已有标准 `navigator.clipboard` 能力，新增 IPC 会扩大平台边界并重复现有消息操作条实现。

## 后果与防回退

- 每个代码块各自维护复制反馈状态，多个代码块互不影响。
- 剪贴板权限被系统拒绝或运行环境不支持时，按钮仍给出统一的短暂反馈；实际写入由浏览器/Electron 环境决定。
- 后续调整代码块头部时必须保留可访问的复制按钮和代码正文的精确复制内容。

## 验证

- 自动化：`pnpm --filter @answra/ui test -- TextResponse.test.tsx themeCss.test.ts`
- 类型：`pnpm --filter @answra/ui typecheck`
- 需要的实机验证：桌面端截图答题返回含代码时，确认代码块右上角能复制到系统剪贴板。

## 风险

- 不同平台的剪贴板权限策略可能导致写入失败；按钮反馈沿用现有消息操作条的容错表现。
