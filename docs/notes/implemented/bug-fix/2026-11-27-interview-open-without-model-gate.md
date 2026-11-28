# Note：面试打开不再触发模型门禁，面板头部只保留模式切换

状态：已实施

## 问题

打开面试面板立刻报错：`Error invoking remote method 'answra:interview:rehearsal-open': Error: auth-required: 请先登录后再使用（设置 → 账户）`。同时面板头部出现含义不明的“重试”“资料”，标题被挤成“面...”。用户明确要求面试不需要登录即可打开，并删掉那两个按钮。

## 涉及范围

- `apps/desktop/src/main/agent/agentService.ts`：打开面试会话只下发工作区与画像种子；模型门禁留在发送/语音启动路径。
- `packages/ui/src/interview/chat/InterviewTextChatPanel.tsx`：头部只剩两个模式按钮，移除“重试”“资料”与 `onOpenIntake` 参数。
- `packages/ui/src/app/InterviewFeaturePanel.tsx`：先移除不可达的 intake 视图分支（后由[面试制作分身到演练阶段](../feature/2026-11-28-interview-preparation-stage.md)恢复为可达入口）。
- `packages/ui/src/interview/chat/useInterviewTextChat.ts`：移除不再使用的 `retryOpen`。
- 测试：`apps/desktop/test/agentService.test.ts`、`packages/ui/test/InterviewDualMode.test.tsx`、`InterviewOnboardingPanel.test.tsx`、`InterviewIntakePanel.test.tsx`。
- 相关 Note：[面试演练与辅助模式](../feature/2026-11-27-interview-rehearsal-and-assist-modes.md)、[登录后才可调用模型](../feature/2026-10-18-login-required-at-model-call.md)。不改登录契约本身，也不改两种模型来源。

## 决定

1. 打开 `interview.rehearsal` / `interview.coach` / `interview.intake` 会话改用机会式解析 `resolveModelIfReady()`：模型就绪就下发配置以支持开场提问，未就绪就跳过，绝不抛用户可见失败。
2. 发送消息与语音启动仍调用 `prepareInterviewModel()`：**本地来源直接可用，云端来源照旧用登录令牌**，两种来源都保留。
3. 面试面板头部只保留“演练/辅助”切换与关闭按钮；“重试”“资料”从面板移除，intake 会话不再从该面板进入。后续由[面试制作分身到演练阶段](../feature/2026-11-28-interview-preparation-stage.md)把 intake 接回制作分身阶段。

## 根因

`openInterviewRehearsal` / `openInterviewAssist` / `openInterviewIntake` 都调用了 `prepareInterviewModel()`，其中 `resolveModel()` 在云端来源且未登录时抛统一失败码。打开一个会话本身不调用模型，把发送门禁提前到打开阶段，导致面板一进入就失败；“重试”正是这个错误的派生按钮，“资料”则是旧的 intake 入口，两者把标题挤到单行省略。

## 修复

- 把 `prepareInterviewModel()` 拆成 `prepareInterviewContext()`（工作区 + 画像种子 + 机会式模型配置）与严格模型解析两步；三个 open 方法只走前者。
- `ModelRouter.resolveIfReady()` 在未配置或未登录时返回 `undefined`，不抛错；`AgentRuntime.hasChatEndpoint()` 让 `InterviewApplication.open()` 在无端点时只恢复空会话，不启动开场 Turn。
- 头部 `headerAction` 只保留 `<fieldset>` 模式切换；`InterviewFeaturePanel` 不再持有 `view` 状态，也不再渲染 `InterviewIntakePanel`（该入口由后续阶段 Note 恢复）。
- `InterviewIntakePanel` 组件与其测试保留，改为直接渲染测试；Agent 侧 `interview.intake` 会话与桥接方法不变。
- 测试新增：桌面侧断言三个 open 都不触碰严格的 `resolveModel`、模型就绪时仍下发 `configure`，而 `sendInterviewMessage` 仍以 `auth-required` 拒绝；Agent 侧断言无端点时 `open()` 不启动开场 Turn；UI 侧断言头部没有“资料”“重试”。

## 曾考虑的替代方案

- **全局取消登录门禁：** 舍弃。云端调用没有令牌就发不出去，且会推翻既有跨模块契约；本轮只解决打开阶段的误用。
- **面试只允许本地模型：** 舍弃。用户明确要求两种来源都支持；本地/云端的裁决仍由 `ModelRouter` 唯一负责。
- **在 UI 吞掉 `auth-required`、保留打开门禁：** 舍弃。只藏住报错但会话仍没配置好，发送消息必然更晚失败，属于掩盖问题。
- **保留“资料”按钮、改成图标按钮：** 舍弃。用户要求删掉该入口；资料整理仍由引导阶段完成，画像写入归 `interview.intake`。

## 后果与防回退

- 打开面试会话不得调用严格的 `resolveModel`；机会式解析拿不到模型时必须跳过，不能把失败抛到打开阶段。
- 云端来源未登录时，错误应在用户**发送消息之后**出现，而不是打开面板时出现；回归时先看 `openInterview*` 是否误调 `prepareInterviewModel`。
- 面试面板头部不允许增加新的常驻文字按钮，否则标题会再次被挤成省略号。
- `interview.intake` 会话与画像写入规则不变；后续已由[面试制作分身到演练阶段](../feature/2026-11-28-interview-preparation-stage.md)另立 Note 恢复资料整理入口，位置在制作分身阶段，而不是复用被删除的头部按钮。

## 验证

- `pnpm --filter @answra/desktop exec vitest run test/agentService.test.ts`：新增用例通过，三个 open 不调用严格的 `resolveModel`、模型就绪时仍下发 `configure`，发送仍被 `auth-required` 拒绝。
- `pnpm --filter @answra/agent exec vitest run test/interview/application.test.ts`：无端点时 `open()` 返回空快照且不产生开场 Turn。
- `pnpm --filter @answra/ui exec vitest run test/InterviewDualMode.test.tsx test/InterviewIntakePanel.test.tsx test/InterviewOnboardingPanel.test.tsx`：通过；断言头部无“资料”“重试”，标题不再被按钮挤压。
- 全量 `pnpm verify` 退出码 0：desktop 379 passed / 2 skipped、UI 365/365、Agent 829/829 及其余各包测试全绿，静态门禁通过。
- 需要 Windows 桌面端实测：未登录时打开面试面板无报错、标题完整显示；本地模型可直接发送，云端来源在发送时才给出登录提示。自动化不替代这一步。
