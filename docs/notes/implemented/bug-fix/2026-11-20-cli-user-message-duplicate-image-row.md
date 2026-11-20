# Note：CLI 用户消息重复渲染图片附件行

状态：已实施

## 问题

发送带图片的用户消息后，transcript 中同一条图片出现两次：

- 正文里已有输入框插入的 `[Image #N]` 内联引用；
- 下方又渲染一行 `[Image #1] clipboard.png`。

用户认为这是重复信息，要求删掉下面多出来的一行。

## 涉及范围

- 代码/模块：`apps/cli/src/tui/transcript/MessageRow.tsx`、`apps/cli/src/tui/transcript/UserImages.tsx`（删除）、`apps/cli/src/tui/transcript/virtualLayout.ts`、`apps/cli/src/image/attachment.ts`
- UI/进程/协议/持久化表面：CLI transcript 的 user 消息布局与虚拟滚动高度估算；`ConversationViewMessage.images` 仍保留在数据层
- 相关 Note：`docs/notes/implemented/feature/2026-11-16-cli-image-input.md`、`docs/notes/implemented/feature/2026-11-17-cli-image-paste-inline-reference.md`

## 根因

11-16 的图片输入功能在 `MessageRow` 中新增 `UserImages` 列表，渲染 `[Image #N]` 与文件名。11-17 改为在输入框文本中插入 `[Image #N]` 内联引用并随消息文本提交，于是同一引用既在正文里出现，又触发了旧的附件列表，形成重复。删除引用会同步移除附件，因此正文中的内联标记足以代表图片存在。

## 决定

- 删除 transcript 中的 `UserImages` 附件列表，user 消息只渲染正文；图片仍通过正文里的 `[Image #N]` 标记可见。
- 删除不再被引用的 `UserImages.tsx` 与 `imageLabel`，不保留无调用方的组件或工具函数。
- 虚拟滚动高度不再为图片附件预留行，`messageMeasureKey` 也不再包含图片数量与文件名长度。
- 不改变协议、Agent 请求里的图片数据，也不改变输入框的内联引用与提交映射。

## 修复

- `MessageRow` 的 user 分支只渲染正文，移除 `UserImages` 引用与附加上边距逻辑。
- 删除 `UserImages.tsx` 与 `imageLabel`；`virtualLayout` 的用户消息高度改为正文行数 + 1，测量 key 去掉图片字段。
- 更新 transcript 与虚拟布局测试，断言正文只出现一次内联引用、不出现文件名，且图片不再增加高度。

## 曾考虑的替代方案

- **只隐藏文件名，保留第二行 `[Image #N]`。** 仍是同一引用重复显示，未解决用户指出的问题。
- **删除正文中的内联引用，只保留附件列表。** 会破坏图片与文本的位置关系，且让模型收到的文本缺少引用上下文，与 11-17 的内联引用决定冲突。
- **仅当正文不含 `[Image #N]` 时才渲染附件列表。** 需要额外的文本解析和边界状态；CLI 提交路径保证引用已写入正文，属于无触发场景的防御分支。

## 后果与防回退

- 带图片的用户消息在 transcript 中只显示正文，图片以 `[Image #N]` 标记出现，不再显示文件名。
- 若未来允许不带内联引用的图片消息（例如其他宿主写入的 transcript），需要重新设计一个不重复的单行图片提示，而不是恢复附件列表。
- 回归测试断言正文只有一次 `[Image #N]` 且不出现文件名；高度估算测试不得再为图片预留额外行。

## 验证

- `pnpm --filter @answra/cli exec vitest run test/tui/transcript`：通过（含新的去重断言与高度估算断言）。
- `pnpm --filter @answra/cli typecheck`：通过。
- `pnpm exec biome check apps/cli/src/tui/transcript/MessageRow.tsx apps/cli/src/tui/transcript/virtualLayout.ts apps/cli/src/image/attachment.ts apps/cli/test/tui/transcript/virtualLayout.test.ts apps/cli/test/tui/transcript/tui.transcript.test.tsx`：通过。
- 需要在 Windows Terminal 中手动确认发送图片后 transcript 只出现一次 `[Image #N]`。
