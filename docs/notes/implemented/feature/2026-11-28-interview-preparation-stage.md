# Note：面试制作分身 → 开始演练的两阶段入口

状态：已实施

## 问题

面试引导完成或跳过后，`InterviewFeaturePanel` 直接渲染演练/辅助面板，`InterviewIntakePanel`（`interview.intake` 资料整理对话）没有任何可达入口。结果是想“制作面试分身”的用户只能面对一个还不了解自己的面试官：

- 引导里填过简历/项目时，演练官能靠只读种子读资料，但不会主动补画像；
- 直接跳过引导时上下文为空，演练只能退化成通用提问。

用户要求把制作分身放回「面试演练」内部：先用语音/文字对话建立画像，AI 资料足够时询问是否开始演练。本变更先交付文本闭环，语音采集另行接入。

## 涉及范围

- `packages/shared/src/channels/interview.ts`：`InterviewOnboardingState` 增加 `rehearsalStartedAt`；新增 `answra:interview:rehearsal-start` 频道。
- `packages/shared/src/bridge.ts`、`apps/desktop/src/preload/index.ts`：新增 `startInterviewRehearsal`。
- `apps/desktop/src/main/interview/interviewOnboardingState.ts`：旧状态缺少该字段时读取为 `null`，不提升状态版本；v1 迁移也补 `null`。
- `apps/desktop/src/main/interview/interviewOnboardingStore.ts`：新增 `startRehearsal()`；`reopen()` 清空演练标记。
- `apps/desktop/src/main/interview/interviewOnboardingIpc.ts`：注册 `RehearsalStart`，沿用窗口来源校验。
- `packages/ui/src/app/InterviewFeaturePanel.tsx`：按 `rehearsalStartedAt` 分流制作分身与演练。
- `packages/ui/src/interview/intake/InterviewIntakePanel.tsx`：头部改为「资料」+「开始面试演练」，移除「返回」。
- `packages/ui/src/interview/onboarding/useInterviewOnboarding.ts`：暴露 `startRehearsal`。
- `apps/agent/src/interview/intake/profile.ts`：资料足够时口头询问是否开始演练，但明确切换只认按钮。
- 测试：`packages/ui/test/InterviewOnboardingPanel.test.tsx`、`InterviewDualMode.test.tsx`、`InterviewIntakePanel.test.tsx`、`apps/desktop/test/interviewOnboardingStore.test.ts`、`interviewOnboardingIpc.test.ts`。
- 相关 Note：[面试引导与候选人档案首次使用流程](../../proposed/feature/2026-11-11-interview-onboarding-and-avatar.md)、[面试 intake 对话页与画像补全](2026-11-19-interview-intake-conversation.md)、[面试演练与辅助双模式](2026-11-27-interview-rehearsal-and-assist-modes.md)、[面试打开门禁与头部精简](../bug-fix/2026-11-27-interview-open-without-model-gate.md)。

## 决定

1. **面试入口分两阶段**：`InterviewOnboardingState.rehearsalStartedAt` 为空时进入制作分身（`interview.intake`），非空时进入演练/辅助。阶段由持久化事实决定，不靠解析模型回复或猜测画像完整度。
2. **切换只认显式动作**：`interview.intake` 可以在资料足够时口头问“现在开始演练吗”，但真正的阶段切换只由用户点击「开始面试演练」触发；renderer 调 `startInterviewRehearsal`，主进程写入时间戳，不接受模型产生的自然语言开关。
3. **状态放在 `wizard.json`**：`rehearsalStartedAt` 与引导进度同文件，不新增制作状态文件，也不把“画像是否够用”写成第二套状态。
4. **重新打开引导会清空演练标记**：`reopen()` 把状态改回 `pending` 并清空 `rehearsalStartedAt`，用户改完资料后重新停在制作分身；`complete()` / `skip()` 保持当前标记不变。
5. **不提供“继续完善资料”入口**：演练阶段头部只有模式切换与关闭。用户的产品决定是演练结束后由演练 Bot 召唤资料整理者，而不是让用户自己找入口；交接链路见 [演练/辅助 Bot 交接给资料整理者](2026-11-28-interview-profile-review-handoff.md)。
6. **制作分身与演练仍是两个 Agent、两份 transcript**：`interview.intake` 唯一写 `profile.xml`，`interview.rehearsal` / `interview.coach` 只读；本变更不改三 Agent 边界。

## 影响表面

- 用户行为：引导完成/跳过后先看到「制作面试分身」，AI 读简历与项目、用对话补画像；点「开始面试演练」后才进入演练/辅助，之后再次打开直接回到演练。
- 协议：新增一个频道与一个 bridge 方法；`InterviewOnboardingState` 多一个字段，旧 `wizard.json` 读取兼容，不需要迁移版本。
- 持久化：仍只有 `wizard.json` 与 `profile.xml`；`rehearsalStartedAt` 是用户显式动作记录，不是模型判断结果。
- 模块边界：renderer 只开关阶段，不传 conversation ID、prompt 或画像路径；资料写入仍只走 `interview.intake` 的 `workspace.edit`。

## 曾考虑的替代方案

- **保留“继续完善资料”按钮作为回退入口：** 舍弃。用户明确要求删掉该入口，改由演练 Bot 召唤资料整理者；留按钮会形成第二套切换语义。
- **根据画像内容或模型判断是否“资料足够”自动进演练：** 舍弃。会把状态判断塞进模型输出，无法复现、无法测试，也容易在用户还没准备好时跳阶段。
- **把阶段也做成 `InterviewOnboardingStatus` 的一个值：** 舍弃。引导状态表达“向导是否完成”，演练阶段表达“用户是否开始使用”，两者独立；合并会让 `reopen()` 与 `complete()` 的语义互相污染。
- **新增独立的 rehearsal 状态文件：** 舍弃。一个时间戳不值得多一份持久化文件和恢复路径，且与既有“不新增制作状态文件”的决定冲突。

## 后果与防回退

- `rehearsalStartedAt` 只能由用户显式动作写入；禁止在 `complete()`、`skip()` 或模型回复里自动置位。
- 制作分身的 UI 入口必须保持在 `InterviewFeaturePanel` 内；`interview.intake` 不能从顶层模式或 renderer 注入路径进入。
- 演练阶段没有手动返回制作分身的入口。回退只能由演练/辅助 Bot 通过结构化交接触发（只提交请求，Turn 收口后由宿主清空 `rehearsalStartedAt`），见 [演练/辅助 Bot 交接给资料整理者](2026-11-28-interview-profile-review-handoff.md)；不得让渲染层解析自然语言或新增隐藏入口。
- 仍禁止 `interview.rehearsal` / `interview.coach` 获得 `workspace.edit`；画像写入口只有 `interview.intake`。

## 验证

- `packages/ui/test/InterviewOnboardingPanel.test.tsx`：完成/跳过后进入制作分身并打开 intake 会话；点「开始面试演练」调用 `startInterviewRehearsal` 后进入演练；已开始过则直接进演练且没有「继续完善资料」入口。
- `apps/desktop/test/interviewOnboardingStore.test.ts`：未完成引导时 `startRehearsal()` 不改状态；完成后写入时间戳且幂等；`reopen()` 清空标记。
- `apps/desktop/test/interviewOnboardingIpc.test.ts`：`RehearsalStart` 的窗口来源校验与 store 调用。
- `pnpm --filter @answra/shared --filter @answra/ui --filter @answra/desktop --filter @answra/agent typecheck` 通过；相关 UI 22 个测试、desktop 26 个测试通过。
- 全量 `pnpm verify` 退出码 0、`pnpm notes:check` 退出码 0；shared 72、config 21、tts 60、ui 397、desktop 396（2 skipped）、agent 834、cli 414 等测试全部通过。

## 风险

- 旧用户已经完成引导但没有 `rehearsalStartedAt`，升级后会先看到制作分身，而不是原来的演练页；这是本变更的预期行为，但需要在实机验收时确认文案不会让人误以为资料丢失。
- 在“召唤资料整理者”实现前，已开始的用户无法从 UI 回到制作分身；如果验收发现必须回退，只能通过重新打开引导（当前演练页未暴露该入口）或后续交接能力解决。现状：交接已实现，但只由 Bot 在允许的三种情况下触发，仍不提供用户手动入口。
- 制作分身的质量仍取决于 intake prompt 与模型；文本闭环验收通过后再接麦克风采集与 TTS，语音阶段不改变本 Note 的阶段状态来源。
