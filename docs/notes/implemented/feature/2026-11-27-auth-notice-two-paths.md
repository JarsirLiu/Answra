# Note：登录失败提示同时给出「登录账户」与「配置本地模型」两条路

状态：已实施

## 问题

未登录时使用云端来源，对话与面试都显示同一句 `AUTH_REQUIRED_NOTICE` 和一个「去登录」按钮。用户只有一条路可走：登录云端订阅。想用自己的模型（本地 OpenAI 兼容服务）的用户从这条提示里看不到任何入口，只能自己猜「是不是要去设置里找」。此外原文案写着「（设置 → 账户）」，但按钮实际直接拉起浏览器授权页，文案描述的位置与按钮行为不一致。

## 涉及范围

- `packages/ui/src/components/chat/ModelErrorNotice.tsx` / `.module.css`：新增可选 `onConfigureModel`，与 `onSignIn` 并列渲染两个动作按钮。
- 接线：`ChatPanel`、`ReplyBar`、`ReplyConversationPopover`、`ReplyDetails`、`ChatFeaturePanel`、`InterviewTextChatPanel`、`InterviewFeaturePanel` 逐层透传 `onConfigureModel`，不在 presentation 层判断账号或模型来源。
- `packages/ui/src/app/FloatingBarApp.tsx`：读取 `bridge.getConversationConfig()` 的 `localAvailable` 决定是否传第二个动作；点击时 `surfaces.openPanel("settings")`。
- 测试：`ModelErrorNotice.test.tsx`（两个动作独立触发）、`FloatingBarApp.conversation.test.tsx`（本地可用时两条路都在、点击真的打开设置；不可用时只显示登录）、`InterviewDualMode.test.tsx`（面试面板同样给出两条路）。
- 不改 `AUTH_REQUIRED_NOTICE` 契约、`isAuthRequiredError` 判定、默认云端来源、桌面主进程门禁或 Electron / IPC 层。相关 Note：[面试登录失败改为用户可读提示](../bug-fix/2026-11-27-interview-auth-error-user-facing.md)、[统一模型错误提示](2026-10-19-unified-model-error-notice.md)、[答题包支持本地模型](2026-11-17-answer-package-local-model.md)。

## 决定

1. 失败提示同时呈现两个**真实动作**：`去登录` 调 `loginAccount()` 打开授权页；`配置本地模型` 打开「设置」面板（默认落在包含「模型」分组的「设置」页）。两个按钮都只在用户主动点击时生效，失败本身不自动跳转。
2. 第二个按钮按运行时 `localAvailable` 显示。full 打包版本地来源被产品策略折叠为云端（`localAvailable=false`），给一个点进去看不到模型配置的按钮是死路，所以该包只显示登录。开发态与 answer 包显示两条路。
3. 判定仍然只来自共享失败码与桥返回的可用性字段；渲染层不解析自然语言、不猜 profile 名、不自己决定模型来源。
4. 不改变「失败留在发起表面」的呈现规则：点配置只是切换面板、不写配置。打开设置会卸载当前对话面板，失败提示随之消失；用户配置完重新发送即可，不在设置里叠加第二层失败状态。

## 影响表面

- 用户：未登录发送不再只有「登录」一条明示路径；支持本地来源的包里可当场选择去设置配自己的模型，full 包仍只提供登录。
- 提示组件：`ModelErrorNotice` 从「文案 + 可选登录」扩展为「文案 + 两个可选动作」；只传 `onSignIn` 的旧表面行为不变。
- 设置面板：成为「配置本地模型」动作的目的地，本身不改 Tab 结构与表单；模型来源切换仍由设置页既有逻辑完成。
- 测试：组件层验证两个动作独立触发，集成层验证点击真的打开设置面板且 full 包形态不出现死路按钮。

## 曾考虑的替代方案

- **把文案改成一句话写两条路，但不加按钮：** 舍弃。用户看到指示却没有可点的动作，仍需自己导航，等于没解决。
- **无条件显示「配置本地模型」：** 舍弃。full 包里设置页整块「模型」分组不渲染，按钮会变成死路，违背既有订阅门禁决策。
- **按 profile 名或 `app.isPackaged` 在 UI 里判断可用性：** 舍弃。可用性已由主进程按发布清单裁决并经 `getConversationConfig()` 暴露，UI 复制判断会产生第二个真相来源。
- **「去登录」改成跳转「设置 → 账户」再让用户点登录：** 舍弃。多一次点击，且与既有 `loginAccount()` 行为及账户面板测试冲突；不解决第二个问题。
- **把两条路做成新弹窗/新组件：** 舍弃。`ModelErrorNotice` 已是对话、回复条、浮层、面试共用的唯一呈现，扩展它就是最小改动。

## 后果与防回退

- 登录提示在支持本地模型的包里必须有两个按钮；只出现一个时先查 `getConversationConfig()` 是否可用、`needsSignIn` 是否为真，而不是放宽断言。
- 新增使用 `ModelErrorNotice` 的表面时，必须同时评估是否传 `onConfigureModel`；只传 `onSignIn` 会让该表面重新退化成单条路。
- 「配置本地模型」只打开设置面板，不写配置、不改变来源；来源切换仍只由设置页的既有表单和 `configureConversation()` 完成。
- 默认来源仍是 `cloud`；不得借这次提示改动悄悄改默认值。

## 验证

- `pnpm --filter @answra/ui exec vitest run test/ModelErrorNotice.test.tsx test/FloatingBarApp.conversation.test.tsx test/InterviewDualMode.test.tsx`：组件层两动作分别触发；对话/面试在 `localAvailable=true` 时给出两个按钮，点「配置本地模型」后设置面板与「模型」分组真实出现；不可用时只保留「去登录」。
- 全量 `pnpm verify` 退出码 0。
- 需实机确认：未登录发送后提示里能直接选登录或去设置配本地模型；配好本地模型后切到本地来源发送不再出现登录提示。
