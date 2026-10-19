# Note：模型调用失败提示统一到一处

状态：已实施

## 问题

「模型调用失败」在同一时刻有 3 种长相，用户看到的提示取决于失败发生在哪个组件：

- 回复条流式/终态：`ReplyActivityTicker` 把失败降级成一行跑马灯活动项（`模型错误 <文案>`）；
- 回复条编辑态：`ReplyBar` 里一个纯文字 `<span class="reply-error">`，`nowrap + 省略号`，长文案直接被截断；
- 展开的对话浮层：`ReplyConversationPopover` 里 `AlertCircle + 文案` 的 `.reply-conversation-error`（且自带「有 error 活动项就不再显示」的手写去重）；
- 主对话面板：**完全没有失败提示**。

登录门禁（[调用模型需要登录](./2026-10-18-login-required-at-model-call.md)）落地后问题叠加：未登录发送会同时弹一个浮层横条（`send-error` notice）并自动把面板切到设置页，同一次失败出现两处提示、还抢走用户当前表面。产品要求是「只有模型调用需要登录；失败就在 AI 回复这里提示去登录」，因此失败提示必须收敛成同一处、同一份实现。

## 涉及范围

- 代码/模块：新增 `packages/ui/src/components/chat/ModelErrorNotice.tsx`（+ `.module.css`，经 `components/chat/index.ts` 导出）；`packages/ui/src/components/panels/ChatPanel.tsx`、`ReplyBar.tsx`、`ReplyConversationPopover.tsx`、`packages/ui/src/app/FloatingBarApp.tsx`、`ReplyBarWindowApp.tsx`、`packages/shared/src/channels.ts`（`isAuthRequiredError` 放宽入参）。
- UI/进程/协议/持久化表面：失败提示改为内联在发起表面（对话正文末尾 / 回复条 / 展开浮层），删除浮层 `send-error` notice 与「自动打开设置面板」；`ReplyBarState.replyError`（跨窗口协议）语义从「流式错误」扩展为「本轮失败文案」，字段与类型不变；不新增持久化。
- 相关 Note：[调用模型需要登录](./2026-10-18-login-required-at-model-call.md)、[模型调用失败必须终结并显示](../bug-fix/2026-10-12-visible-model-failures.md)。

## 决定

- **唯一实现 `ModelErrorNotice`**：`AlertCircle + 文案（+ 可选「去登录」）`，`role="alert"`。对话面板正文末尾、回复条编辑态、展开的对话浮层三处共用，样式只此一份（CSS module）。
- **按钮是显式动作**：`onSignIn` 由调用方在确认 `isAuthRequiredError` 为真时传入；渲染出「去登录」按钮才允许调 `loginAccount()`。失败本身不自动打开浏览器、不自动切换面板（推翻登录 Note 初版的「自动打开设置面板」）。
- **同一表面同时最多一处**：本轮已有流式 `kind:"error"` 活动项时不再渲染 notice（原先写在 popover 里的去重判断上收为使用约定）；传输层失败（`replyFailure`）优先于流式错误文案（`answer.replyError`），两者合并成一个值而不是并排显示。
- **对话面板补齐流式错误**：面板的失败位同时承接「发送被拒」（`chatFailure`）与「本轮流式 error chunk」（`conversation.replyError`），传输层优先——在此之前主对话面板对两类失败都不可见。
- **`isAuthRequiredError` 放宽到接受裸字符串**：流式 error chunk 与组件状态里保存的就是文案本身，判定来源仍然只有 `AUTH_REQUIRED_CODE` 一处。
- **登录成功即清提示**：`onAuthStatus` 报 `signedIn` 后清空两个失败状态——原因已经不存在，留着只会误导。
- **保留 ticker 的错误活动项**：它是本轮回复正文（流式时间线）的一部分，不是旁路提示，换掉会破坏活动流，因此不动。
- **独立回复窗复用同一份**：`ReplyBarWindowApp` 从 `ReplyBarState.replyError`（含登录码）判断是否给出「去登录」，不再自己写一套。

## 影响表面

- 未登录发送：对话面板正文末尾 / 回复条出现同一句「请先登录后再使用（设置 → 账户）」+「去登录」按钮；草稿与截图保留。点按钮才打开浏览器授权页，打开失败时提示文案原地换成失败原因（不再点了没反应）。
- 其它模型失败（网络中断、服务未连接、模型报错）：同一位置、同一长相显示原始文案，无按钮。
- 对话面板此前对模型失败毫无反馈（发送被拒与流式错误都看不见），现在两类失败都显示在正文末尾；关闭面板即清掉发送失败提示，下一次发送清掉流式错误文案。
- 回复条编辑态提示改为可换行，长文案不再被省略号截断；执行「重新发送」或关闭面板会清掉上一轮提示。
- 展开的对话浮层里「读取对话失败」也走同一组件（同一表面的失败长相统一）。

## 曾考虑的替代方案

- **只统一文案、保留三处各自渲染**：失败提示的观感会随组件继续漂移，且主对话面板仍需从零写一套（否决）。
- **「去登录」按钮改为 `openPanel("settings")`**：用户要多点一次才能看到登录按钮，且独立回复窗根本打不开主窗口的设置面板（否决，改为直接 `loginAccount()`）。
- **`isAuthRequiredError` 只接受 `Error`，调用方用 `new Error(text)` 包装**：判定点散落到每个调用方，与「失败码是唯一判定来源」冲突（否决）。
- **把 ticker 的 `模型错误` 活动项也换成 notice**：流式期间 notice 会与活动流抢同一块区域，等于把「两者同时出现」换个形式（否决）。
- **失败时自动打开设置面板（初版做法）**：用户明确要求不要自动切面板、不要在 AI 回复之外另弹横条（由本变更推翻）。

## 后果与防回退

- 模型失败提示只有一个实现：新增表面要显示模型失败必须复用 `ModelErrorNotice`，不得再写新样式或新的浮层 notice 通道。
- 同一表面不得同时出现 notice 与 `kind:"error"` 活动项。
- `onSignIn` 只在 `isAuthRequiredError` 为真时传入；禁止在失败发生时自动调用 `loginAccount()` 或自动切换面板。
- 登录提示的判定来源仍是 `AUTH_REQUIRED_CODE`/`AUTH_REQUIRED_NOTICE`，不得解析其它文案或网关错误码。

## 验证

- `packages/ui/test/ModelErrorNotice.test.tsx`（2 项）：默认无按钮；只有传入 `onSignIn` 才渲染「去登录」并在点击时回调。
- `packages/ui/test/ChatPanel.test.tsx`（新增 1 项）：失败文案出现在 `role="log"`（消息流）内，「去登录」点击回调生效。
- `packages/ui/test/FloatingBarApp.test.tsx`：对话失败 → 提示落在对话消息流内、草稿保留、不出现设置面板的「登录」按钮、点「去登录」调用 `loginAccount`；截图答题失败 → 同一提示可见且有「去登录」。
- `packages/ui/test/ReplyBarWindowApp.test.tsx`、`replyConversation.test.tsx`、`ReplyActivityTicker.test.tsx`：独立回复窗与活动项行为不变。
- `pnpm verify`（lint + notes:check + typecheck + test + architecture:check）通过。

## 风险

- 提示长相统一后，不同失败类型的区分只靠文案；如果将来需要更强的视觉分级（警告/错误），应在 `ModelErrorNotice` 上加变体，而不是复制一份新样式。
- 「去登录」按钮在独立回复窗里直接打开浏览器授权页，与主窗口的登录路径一致；两处都不等待授权结果，登录结果由 `onAuthStatus` 推送。
