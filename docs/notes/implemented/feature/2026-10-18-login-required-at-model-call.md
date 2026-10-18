# Note：调用模型需要登录（统一失败码 + 不静默失败）

状态：已实施

## 问题

产品要求「免费也能用，但要先登录」：对话与截图答题属于免费档，条件是 `signedIn`，与会员 `plan`/`capabilities` 无关。此前桌面端没有任何登录门禁——未登录用户照样能发消息调用本地模型，账号体系的"免费档"根本不存在。

同时暴露一个更基础的缺陷：**模型调用失败会被静默吞掉**。`useChat` 的 `makeRequest` 会把传输层异常（远程调用抛错、服务未连接）自行捕获并只设置内部 `error` 状态，`sendMessage` 不 reject；`useAiConversation.send()` 因此永远停在 `await terminal`，截图回复条卡在「思考中」，对话面板的 `.catch` 分支（原有恢复草稿与提示）永远不会执行。任何"未登录提示"如果不修这条，同样显示不出来。

## 涉及范围

- 代码/模块：`packages/shared/src/channels.ts`（`AUTH_REQUIRED_CODE` / `AUTH_REQUIRED_NOTICE` / `isAuthRequiredError` / `authRequiredError`）、`packages/shared/src/index.ts`、`apps/desktop/src/main/conversation/conversationIpc.ts`、`apps/desktop/src/main/auth/authService.ts`（`hasSession`、`restored`）、`apps/desktop/src/main/index.ts`、`packages/ui/src/app/useConversationChat.ts`、`packages/ui/src/app/useReplyWorkflow.ts`、`packages/ui/src/app/FloatingBarApp.tsx`。
- UI/进程/协议/持久化表面：`answra:conversation:send` 新增一种可识别失败（错误文案内含 `auth-required`）；对话发送失败与截图答题失败都显示同一个可关闭提示（`send-error`），未登录时提示"请先登录后再使用（设置 → 账户）"并同时打开设置面板；不新增持久化，不改变 token 存放位置。
- 相关 Note：[桌面端账号登录与凭据（Phase 0）](../feature/2026-10-17-desktop-account-login-and-credentials.md)、[刷新失败不再等同登出](../bug-fix/2026-10-18-refresh-failure-keeps-session.md)、[模型调用失败必须终结并显示](../bug-fix/2026-10-12-visible-model-failures.md)。

## 决定

- **门禁放在 main 的 `ConversationChannels.Send` 处理里**，覆盖 `chat.send` 与 `answer.run` 两个模型调用操作：未登录时抛出统一失败码错误，不把请求交给本地 agent。
- **失败码是唯一的判定来源**：`AUTH_REQUIRED_CODE = "auth-required"` 与用户可见文案 `AUTH_REQUIRED_NOTICE` 定义在 `packages/shared/src/channels.ts`，渲染层只用 `isAuthRequiredError(error)` 判断（消息包含该码即可，兼容 Electron IPC 重新包装后的错误文案），不解析任何错误自然语言。
- **门禁只做体验层提示，不做授权**：本地模型调用是本机 BYO API Key 路径，客户端门禁天然可被绕过；真实授权永远由服务端在云端入口强制。因此判定采取"宁可漏报不可误报"——`AuthService.hasSession()` 在 `restore()` 尚未完成时返回 `true`（登录态未知不等于未登录），避免冷启动首屏把已登录用户挡在门外。
- **未登录提示不自动拉起浏览器**：提示与账户入口一起给出（打开设置面板，"登录"按钮由用户自己点）。桌面端常在会议/面试场景使用，静默弹出系统浏览器会打断当前场景。
- **传输层失败必须回到发送方**：`useAiConversation` 给 `useChat` 传 `onError`，把被 SDK 吞掉的异常重新 `reject` 给等待中的 `send()`，并清掉 pending。这与既有 Note「模型调用失败必须终结并显示」同一原则：失败要么有终态、要么有提示，不能停在中间态。
- **本轮不做**：服务端 `capabilities` 目录下发免费档能力 ID、按 `plan` 的订阅档门禁、云端调用入口。免费/订阅分档的判定条件仍是 `signedIn`（本轮）与 `capabilities`（将来）。

## 影响表面

- 未登录用户在对话面板或截图回复条发送 → 收到"请先登录后再使用（设置 → 账户）"，输入草稿/截图保留，设置面板同时打开，用户登录后可直接重发。
- 已登录用户行为不变（门禁不产生额外请求，`hasSession()` 是同步内存判断，不触发网络）。
- 截图答题发送失败不再静默：以前只在控制台留一行，现在显示提示并回到可重试的编辑态。
- 通用发送失败提示的 layer id 统一为 `send-error`（原对话路径的 `conversation-error` 取消），同类失败在两条路径上互相覆盖而不是叠加。

## 曾考虑的替代方案

- **渲染层预门禁（发送前先查 `getAuthStatus`，未登录直接拦住）：** 需要渲染层自己维护"登录态是否已知"，冷启动首屏必然误判；且对话与截图两条路径要各写一遍判断。改用 main 的调用边界 + 失败码，两处自动一致。
- **渲染层直接调 `loginAccount()` 自动拉起授权页：** 最贴近"一键登录"，但会在用户开会/面试时突然弹出系统浏览器；改为提示 + 账户入口，把时机交给用户。
- **只在 UI 层显示原始错误文案（不引入失败码）：** IPC 包装后的文案是 `Error invoking remote method 'answra:conversation:send': Error: …`，既难看又无法稳定判定（文案随网关/服务端变化）；必须有一个稳定的码。
- **把门禁放在 agent 侧（`AgentService.send`）：** agent 运行时按约定与 Electron、凭据无关，不应知道登录态；`isSignedIn` 端口由 main 注入到 IPC 层更符合分层。
- **未登录时直接禁用发送按钮：** 属于"入口预门禁"，未登录用户看不到原因就把功能判死刑，且与用户明确要求（发消息时才提示）相反。

## 后果与防回退

- `auth-required` 这个码是跨进程契约：改文案可以，改码必须同时改 `packages/shared`、main 门禁与所有 UI 判定点。
- 渲染层不得根据 `plan`/`capabilities` 决定免费功能（对话、截图答题）的可用性：免费档条件是 `signedIn`。
- `useChat` 的 `onError` 是"失败可达"的唯一通道，移除它会让截图发送重新卡在「思考中」。
- `hasSession()` 不得改为触发网络或刷新：它会在发送路径上被同步调用。
- 门禁不是授权机制：任何安全结论不得依赖它（服务端强制是唯一授权点）。

## 验收标准

- 未登录：`answra:conversation:send`（`chat.send` 与 `answer.run`）都被拒绝且不调用 `AgentService.send`，错误文案包含 `auth-required`。
- 未登录：对话与截图两条路径都显示同一句提示，草稿/截图保留，账户入口可见。
- 已登录：请求照常转发。
- 传输层失败：`send()` 的 Promise 会 reject（不再永久挂起），截图回复条回到编辑态。

## 验证

- `apps/desktop/test/conversationIpc.test.ts`（5 项）：未登录时 `chat.send`/`answer.run` 都抛 `AUTH_REQUIRED_CODE` 且 `service.send` 未被调用；已登录时照常转发；回复窗口仍被拒（既有用例）。
- `apps/desktop/test/authService.test.ts`：`hasSession` 在 `restore()` 完成前为真、无凭据时为假、有有效会话时为真。
- `packages/ui/test/FloatingBarApp.test.tsx`（42 项）：对话发送被 `auth-required` 拒绝 → 提示"请先登录后再使用（设置 → 账户）"且设置面板打开、出现"登录"按钮；截图答题被拒绝 → 同一提示可见（原先是静默）；既有模型错误用例仍显示 `errorText`。
- `pnpm verify`（lint + notes:check + typecheck + test + architecture:check）通过。

## 风险

- 客户端门禁可被绕过（改代码、直接调 agent），因此它只服务产品体验；真正的能力与计费门禁在服务端，云端调用入口落地时必须在该处再强制一次。
- `restore()` 未完成时按"有会话"处理，理论上存在极短窗口内未登录用户也能发送（此时本地模型仍会正常工作）。这是有意的取舍：宁可漏拦，不可误拦。
- 提示依赖本地化文案常量；将来多语言化时需保留同一码、只替换文案来源。
