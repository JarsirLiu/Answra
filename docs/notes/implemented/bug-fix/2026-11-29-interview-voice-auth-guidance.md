# Note：面试语音的未登录/未配置模型改为正常引导

状态：已实施

## 问题

未登录时点击面试麦克风，面板直接显示：

```text
Error invoking remote method 'answra:interview:start': Error: auth-required: 请先登录后再使用（设置 → 账户）
```

这是 Electron `invoke` 给主进程抛错套的调试外壳，读起来像程序崩溃，而且没有可操作的下一步。本地模型未配置时同样是裸文案。文本会话三年前就有一条「失败码 → 统一文案 → 动作按钮」的链路，语音入口漏接了；`interview.intake` 的文本发送也漏接了，会出同一类错误。

## 涉及范围

- `packages/shared/src/channels/conversation.ts` / `index.ts`：新增 `MODEL_REQUIRED_NOTICE` 与 `isModelRequiredError`，与既有 `AUTH_REQUIRED_NOTICE` / `isAuthRequiredError` 并列。
- `apps/desktop/src/main/conversation/modelRouter.ts`：本地来源缺端点时抛统一文案常量，不再内联字符串。
- `packages/ui/src/modelFailure.ts`：新增唯一的失败收敛 helper，剥 IPC 外壳并按契约码给出 `needsSignIn` / `needsModelSetup`。
- `packages/ui/src/interview/voice/useInterviewMicrophone.ts`：区分模型门禁失败（来自 `startInterview`）与设备/采集失败；前者给出登录或配置动作，后者仍按权限/设备错误文案呈现。
- `packages/ui/src/interview/intake/useInterviewIntake.ts`、`packages/ui/src/interview/chat/useInterviewTextChat.ts`：改用统一 helper，暴露 `needsSignIn` / `needsModelSetup` 与 `signIn`。
- `InterviewIntakePanel.tsx`、`InterviewTextChatPanel.tsx`、`InterviewFeaturePanel.tsx`：把标志接到 `ChatPanel` 的 `onSignIn` / `onConfigureModel`，语音门禁失败优先展示；capture 失败不带按钮。
- 测试：`useInterviewMicrophone.test.tsx`、`InterviewIntakeMicrophone.test.tsx`、`RehearsalMicrophone.test.tsx` 新增未登录、缺本地端点与按钮断言。
- 相关 Note：[面试的登录失败改为用户可读提示与登录入口](../bug-fix/2026-11-27-interview-auth-error-user-facing.md)、[登录失败提示同时给出两条路](../feature/2026-11-27-auth-notice-two-paths.md)、[面试打开不再触发模型门禁](../bug-fix/2026-11-27-interview-open-without-model-gate.md)、[制作面试分身的语音输入](../feature/2026-11-28-interview-intake-microphone-input.md)、[面试演练的麦克风语音输入](../feature/2026-11-28-interview-rehearsal-microphone-input.md)。

## 根因

`useInterviewMicrophone` 早期把 `error.message` 原样写进面板；而 `useInterviewTextChat` 有 `toUserFacingError` 剥外壳、命中 `auth-required` 时换统一文案。于是同一类失败在文本里是引导、在语音里是崩溃串。语音启动走 `startInterview`，模型门禁故意留在这条路径（见「面试打开不再触发模型门禁」），所以这是预期失败，必须按引导处理，而不是取消门禁。

## 决定

1. **模型门禁失败不是采集故障**。只有 `startInterview` 的拒绝被标记为 `modelFailure`；麦克风权限、设备占用、worklet 错误仍走设备文案，且不带登录/配置按钮。
2. **失败语义只由共享契约决定**：`isAuthRequiredError` / `isModelRequiredError` 判语义，文案用共享常量；渲染层不解析自然语言，不再复制第四份 `IPC_ERROR_PREFIX`。
3. **缺本地端点也用共享文案常量**，避免「UI 靠字符串猜模型未配置」；常量同时是 `ModelRouter` 抛出的消息，所以其他表面旧行为不变。
4. **两种来源给出真实动作**：未登录显示「去登录」+「配置本地模型」（沿用两条路的既有决定）；缺本地端点只显示「配置本地模型」。失败本身不自动跳转。
5. **错误优先级**：麦克风错误是最近一次用户动作的结果，优先于会话里残留的错误；但动作按钮只由对应标志决定，普通麦克风错误仍不带按钮。
6. **不取消模型门禁**。云端无令牌发不出请求，本地无端点也没有可调用的服务；把失败藏起来只会让下一次发送更晚失败。

## 修复

- 新增共享 `MODEL_REQUIRED_NOTICE` / `isModelRequiredError`，`ModelRouter` 改抛常量；UI 只用共享判定与文案，不再内联字符串。
- 新增 `packages/ui/src/modelFailure.ts` 统一剥 IPC 外壳，把失败分成「需要登录」「需要配置模型」「普通失败」三类。
- 语音 hook 只对 `startInterview` 的拒绝标记 `modelFailure`，其余设备错误仍按权限/设备文案呈现且不带动作按钮。
- intake 与演练/辅助的文本 hook 改用同一 helper，并把 `needsSignIn` / `needsModelSetup` 接到 `ChatPanel` 的 `onSignIn` / `onConfigureModel`。
- 面板优先级修正为「麦克风错误优先展示，动作按钮由标志决定」，避免普通设备错误被吞掉或误挂登录按钮。

## 曾考虑的替代方案

- **把 `auth-required` 在 renderer 里吞掉、显示空白：** 舍弃。用户不知道下一步，属于掩盖失败；已有 Note 明确否决。
- **只在语音路径判断文案里有没有「登录」：** 舍弃。自然语言随时可变，且共享契约已经有失败码。
- **新增 `model-required` 失败码并给消息加前缀：** 舍弃。对话、回复条等其他表面没有统一的错误码剥离，加前缀会让它们显示 `model-required: …`；改用共享文案常量做等值语义，零回归。
- **让语音启动前先查模型就绪状态：** 舍弃。桥只暴露 `localAvailable`（包能力），不暴露登录态；而且门禁仍在 modelRouter 唯一裁决，renderer 预判会制造第二个真相来源。
- **把登录按钮只放在语音按钮旁边：** 舍弃。`ChatPanel` 已有唯一的 `ModelErrorNotice`，再做一个会形成同一次失败的两种长相。

## 后果与防回退

- 任何新接 bridge 的面试命令，错误都必须经 `toUserFacingFailure` 再进面板；不得在各命令的 `catch` 里拼用户可见文案。
- 新增失败码时优先扩共享 helper，不要把 IPC 外壳或码前缀留在用户可见文案里。
- `needsSignIn` 与 `needsModelSetup` 只来自共享判定；麦克风设备错误不得把它们置真。
- 语音启动时清除上一次的标志与错误；否则旧的登录提示会挂到新一次成功的采集上。
- 安装版入口仍关闭，所以这条引导在开发态可复现，打包版需等入口打开后再实机确认。

## 验证

- `packages/ui/test/interview/useInterviewMicrophone.test.tsx`：模拟 `answra:interview:start` 抛 IPC 包装的 `auth-required` 与缺端点错误，断言提示为统一文案、不含 `Error invoking remote method`、标志正确。
- `packages/ui/test/interview/RehearsalMicrophone.test.tsx`：演练面板在两种门禁失败下分别显示两个动作/仅配置动作，点击真的调用 `loginAccount` 与 `onConfigureModel`；普通设备错误不显示按钮。
- `packages/ui/test/interview/InterviewIntakeMicrophone.test.tsx`：制作分身面板同样给出引导而不是 IPC 串。
- 既有面试相关 UI 测试无回归；全量 `pnpm verify` 与 `pnpm notes:check` 结果见提交记录。

## 风险

- `isModelRequiredError` 按共享文案常量匹配：如果 `ModelRouter` 改文案却忘了同步常量，判定会失效并退回普通错误（仍能显示清洗后的文案，只是没有配置按钮）。测试应覆盖两侧同值。
- auth 提示文案仍带「（设置 → 账户）」而按钮直接拉起授权页，属于既有文案与行为的不一致；本次不借 bug 修复改动默认模型来源或登录契约。
- 语音门禁失败后 `startInterview` 已回滚 capture 状态；用户重新点击会再次走门禁，不会卡在 `starting`。
