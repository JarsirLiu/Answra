# Note：面试的登录失败改为用户可读提示与登录入口

状态：已实施

## 问题

默认模型来源是 `cloud`（`defaultModelSettings()` 固定 `"cloud"`），未登录用户在面试里发送消息时，面板直接显示 `Error invoking remote method 'answra:interview:...': Error: auth-required: 请先登录后再使用（设置 → 账户）`。这段文本带着 Electron IPC 包装外壳，读起来像程序崩溃而不是“需要登录”，而且没有可操作的下一步。

## 涉及范围

- `packages/ui/src/interview/chat/useInterviewTextChat.ts`：统一把失败码转成文案、剥掉 IPC 外壳，暴露 `needsSignIn` 与 `signIn`。
- `packages/ui/src/interview/chat/InterviewTextChatPanel.tsx`：仅在确认需要登录时给 `ChatPanel` 传 `onSignIn`，复用对话域已有的 `ModelErrorNotice`「去登录」按钮。
- 测试：`packages/ui/test/InterviewDualMode.test.tsx` 新增用例，断言提示不含 `Error invoking remote method` 且「去登录」调用 `loginAccount`。
- 不改默认模型来源、不改 `auth-required` 契约、不改主进程门禁。相关 Note：[面试打开不再触发模型门禁](../bug-fix/2026-11-27-interview-open-without-model-gate.md)、[统一模型错误提示](../feature/2026-10-19-unified-model-error-notice.md)。

## 决定

1. 默认仍为云端来源：这是订阅产品的显式选择，本地来源需要用户先配置端点，不能悄悄改默认值。
2. 面试域沿用对话域的呈现标准：失败码判定 → 统一文案 → 可选「去登录」按钮；渲染层只认 `AUTH_REQUIRED_CODE`，不解析自然语言。
3. IPC 外壳只剥前缀、不吞事实：非登录错误仍显示内层真实原因（如「请先在设置 → 模型中配置本地模型服务」）。

## 根因

`useInterviewTextChat` 之前把 `error.message` 原样交给 `ChatPanel`。Electron 的 `invoke` 会把主进程抛错重新包装成 `Error invoking remote method ...: Error: <原始消息>`，于是用户看到的是 IPC 调试文本；同时没有传 `onSignIn`，`ModelErrorNotice` 不显示登录按钮。对话域早已有 `isAuthRequiredError` + `AUTH_REQUIRED_NOTICE` + `onSignIn` 的完整链路，面试域漏接了。

## 修复

- `toUserFacingError`：命中 `isAuthRequiredError` 时返回 `AUTH_REQUIRED_NOTICE`，否则用正则剥掉 `Error invoking remote method ...: Error:` 前缀，保留内层事实。
- hook 返回 `error`（清洗后文案）、`needsSignIn`（只来自共享失败码或登录启动失败）、`signIn`（调用 `bridge.loginAccount()`，未拉起浏览器时给出可读失败）。
- `InterviewTextChatPanel` 只在 `needsSignIn` 时传 `onSignIn`，避免把登录按钮挂到与登录无关的错误上。

## 曾考虑的替代方案

- **把默认来源改成 `local`：** 舍弃。新机器没有本地端点，改默认只会把「要登录」换成「要配置本地模型」，且违背订阅产品的显式选择。
- **在 renderer 吞掉所有 `auth-required`、只显示空白：** 舍弃。用户不知道下一步该做什么，属于掩盖失败。
- **自己写一套面试专用登录弹窗/文案：** 舍弃。对话域已有 `ModelErrorNotice` 与统一文案，重复实现会制造同一次失败的两种长相。
- **按文案里是否含「登录」判断：** 舍弃。`auth-required` 是跨进程契约，自然语言随时可变；判定只走共享函数。

## 后果与防回退

- 面试面板可以出现三种状态且只有三种：正常消息流、清洗后的模型失败提示、带「去登录」的登录提示；不得再出现 IPC 原始错误串。
- 登录按钮只在 `needsSignIn` 为真时出现；普通失败（未配置本地模型、网络错误）不得显示它。
- 默认来源改动必须另立 Note 并同步发布 Profile，不能借这次 UI 修复顺手改。
- 若新增面试发送命令，错误仍由 hook 统一清洗，不要在各命令的 catch 里各自拼文案。

## 验证

- `pnpm --filter @answra/ui exec vitest run test/InterviewDualMode.test.tsx`：新增用例通过，断言提示为统一登录文案、不含 IPC 外壳、点击后调用 `loginAccount`。
- 全量 `pnpm verify` 退出码 0：UI 366/366、desktop 379 passed / 2 skipped、Agent 829/829 及其余各包全绿，静态门禁通过。
- 需要实机确认：未登录切到云端来源发送，看到的是「请先登录后再使用」+「去登录」，点击能打开授权页；本地来源发送不出现登录提示。
