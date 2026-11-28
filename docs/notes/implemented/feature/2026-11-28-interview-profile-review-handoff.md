# Note：演练/辅助 Bot 交接给资料整理者

状态：已实施

## 问题

制作分身 → 面试演练的文本闭环完成后，演练阶段没有任何回到资料整理的路径。产品决定不提供「继续完善资料」按钮，而是由演练官/教练判断时机后召唤资料整理者 Bot。若只是把 intake 拉进当前 Turn，会同时破坏三件事：

- 三个面试 Agent（`interview.rehearsal`、`interview.coach`、`interview.intake`）各自持有一份 conversation，同 Turn 交接会把演练 transcript、工具授权和阶段事实带错；
- 画像只能由 `interview.intake` 写入，交接若直接改 `profile.xml` 会绕过唯一写入口；
- 阶段事实是持久化的 `rehearsalStartedAt`，模型输出或 renderer 自然语言解析都不能决定它。

所以本变更把“召唤”实现为一次受约束的阶段切回：演练/辅助 Bot 只能提交交接请求，Turn 正常收口后由宿主结束演练、把交接说明交给 intake，并广播阶段状态。

## 涉及范围

- `apps/agent/src/interview/tools/profileReviewRequests.ts`：按会话保存内存中的交接请求；`take()` 取走即清空。
- `apps/agent/src/interview/tools/profileReviewTool.ts`：新增 `interview.request-profile-review`，只接受 `reason`（`interview-ended` / `user-requested` / `blocked-by-gap`）与 `summary`（≤2000 字）。
- `apps/agent/src/interview/rehearsal/profile.ts`、`coach/profile.ts`：授权该工具并写入“只在三种情况交接、进行中绝不交接”的 prompt。
- `apps/agent/src/interview/intake/profile.ts`：新增 `interviewIntakeHandoffPrompt(task)`；intake prompt 增加“先处理交接、不重复提问”的约束。
- `apps/agent/src/interview/contracts.ts`、`agentFactory.ts`、`stepBinding.ts`：`InterviewAgentInput.handoffTask`；opening 有交接任务时用交接开场替代首次开场。
- `apps/agent/src/interview/application.ts`：`setHandoffTask()`、`onTurnFinished` 观察口；交接任务只被 opening Turn 消费，Turn 结束即丢弃。
- `apps/agent/src/host.ts`：注册工具；rehearsal/coach 的 Turn 正常收口后发 `interview-stage` 帧；处理 `interview-intake-handoff` 命令。
- `apps/agent/src/worker/protocol.ts`：新增 `interview-stage` 帧与 `interview-intake-handoff` 命令。
- `apps/desktop/src/main/agent/agentWorkerHost.ts`、`agentService.ts`：转发阶段事件、下发交接说明。
- `apps/desktop/src/main/index.ts`：收到阶段事件后按固定顺序收口。
- `apps/desktop/src/main/interview/interviewOnboardingStore.ts`：新增 `endRehearsal()`，只清 `rehearsalStartedAt`，不改 `status` / `step`。
- `apps/desktop/src/main/interview/interviewOnboardingIpc.ts`：新增 `notify(state)` 广播。
- `packages/shared/src/channels/interview.ts`、`bridge.ts`、`apps/desktop/src/preload/index.ts`：新增 `answra:interview:onboarding-changed` 与 `onInterviewOnboardingChanged`。
- `packages/ui/src/interview/onboarding/useInterviewOnboarding.ts`：订阅主进程推送的阶段状态。
- `apps/agent/src/core/transcript/store.ts`、`memoryStore.ts`、`core/session/itemRecorder.ts`：`SessionTurnStartInput.source`；opening 允许在已有历史时没有用户消息，reply 仍必须有可回复的用户消息。
- 测试：`apps/agent/test/interview/profileReviewTool.test.ts`、`application.test.ts`、`agent.test.ts`、`stepBinding.test.ts`、`apps/desktop/test/interviewOnboardingStore.test.ts`、`interviewOnboardingIpc.test.ts`、`packages/ui/test/InterviewDualMode.test.tsx`。
- 相关 Note：[面试制作分身 → 开始演练的两阶段入口](2026-11-28-interview-preparation-stage.md)、[面试 intake 对话页与画像补全](2026-11-19-interview-intake-conversation.md)、[面试演练与辅助双模式](2026-11-27-interview-rehearsal-and-assist-modes.md)。

## 决定

1. **交接 = 阶段切换，不是同 transcript 的 Turn 交接**。三个面试 Agent 继续各持一份 conversation；交接只结束当前阶段并把说明交给 intake，绝不把 intake 拉进演练 transcript。
2. **模型只能提交请求，兑现权在宿主**。工具不写画像、不改阶段，只把 `reason`/`summary` 放进内存请求表；Turn 正常 `completed` 后宿主取走并发 `interview-stage`，失败或中止的 Turn 直接丢弃请求。
3. **允许交接的原因写成枚举**：`interview-ended`、`user-requested`、`blocked-by-gap`。工具描述明确列出三种情况，并写明“进行中的演练/面试、普通追问、单个细节缺失、用户还没回答完”都不算必须。工具结果只回一句“本轮结束时会进入资料整理阶段”，不再提问。
4. **阶段事实仍只有 `rehearsalStartedAt`**。`endRehearsal()` 只把它清空，`status` / `step` 保持完成状态；不复用 `reopen()`，避免把“AI 交接”与“用户重开引导”混成一个动作。
5. **交接说明只进模型请求，不写 transcript**。`open()` 在有待交接任务时即使 intake 已有历史也起一次 opening Turn；说明作为 model-only 开场上下文注入，Turn 结束即从内存丢弃，不落库、不伪造 user 消息。
6. **主进程按固定顺序收口**：停采集 → `interview-intake-handoff` → `endRehearsal()` → 广播 `OnboardingChanged`。renderer 只订阅推送，不轮询、不解析消息内容、不自行推演阶段。
7. **不增加用户确认卡**。这是用户明确选择：Bot 判断后直接切换。代价是“绝对不能中途召唤”只能由工具描述、prompt 和测试保证，代码层没有第二次拦截。
8. **核心 store 只放宽 opening**。`SessionTurnStartInput.source` 让“已有历史但无用户消息的 opening”合法；reply 没有可认领的用户消息时仍然抛错，避免把真正的写坏当成开场。

## 影响表面

- 用户行为：演练结束、用户要求改画像，或资料缺失导致无法继续时，演练官/教练调用交接工具；本轮回复收口后自动回到「制作面试分身」，intake 带着交接说明继续补画像，完成后用户再点「开始面试演练」。
- 协议：worker 新增一个上行帧与一个下行命令；shared 新增一个推送频道与 bridge 订阅方法。
- 持久化：仍只有 `wizard.json` 与 `profile.xml`。交接说明、请求表都在内存；`rehearsalStartedAt` 被清空是唯一持久化副作用。
- 模块边界：工具只在 Agent 进程执行；desktop 只转发事件与阶段状态；renderer 不接触 conversation ID、prompt 或画像路径。

## 曾考虑的替代方案

- **把 intake 作为同一 Turn 的 handoff 接手方：** 舍弃。三份 conversation、三套工具授权和阶段事实都会被搅在一起，还会让 intake 在演练流式输出中途出现。
- **用户点击确认卡后才切换：** 舍弃。用户明确选择“Bot 判断后直接切换”，少一次点击；确认卡会形成第二套阶段控制语义。
- **让 renderer 解析模型回复里的“结束演练”自然语言：** 舍弃。不可复现、不可测试，也违反“renderer 不推演状态”。
- **交接说明作为一条 user 消息写入 transcript：** 舍弃。会污染用户可见历史，且把宿主注入当成用户输入。
- **把交接任务持久化到磁盘：** 舍弃。任务只在本次进程内有效，重启后按当前阶段恢复即可；持久化会引入第二份阶段状态和过期清理规则。
- **在演练面板加回「继续完善资料」按钮作为兜底：** 舍弃。用户明确删除该入口，保留会与 Bot 交接形成两条路径。

## 后果与防回退

- 代码层无法阻止模型在演练中途误调用交接工具；防线是工具描述、rehearsal/coach prompt 与“Turn 完成后才兑现”。修改工具描述时必须保留“禁止进行中调用”的句子，`profileReviewTool.test.ts` 会检查。
- 交接请求只按会话保存且取走即清空；Turn 失败/中止不会切阶段，也不会留下半份请求。
- `interview.intake` 仍是唯一画像写入口；rehearsal/coach 的工具授权不允许 `workspace.edit`，交接工具也不写文件。
- `endRehearsal()` 只允许清空 `rehearsalStartedAt`；不要在交接路径里改 `status` 或 `step`，否则 `reopen()` / `complete()` 的语义会被污染。
- 交接说明不落库：如果进程在 intake 打开前崩溃，说明会丢失，但阶段已切回资料整理，用户重新对话即可，不会留下错误的持久化事实。
- `SessionTurnStartInput.source` 只用于区分 opening/reply；不要在 reply 路径传入 `opening` 绕过用户消息校验。

## 验证

- `apps/agent/test/interview/profileReviewTool.test.ts`：工具记录请求、空说明拒绝、按会话隔离、描述包含禁止条款。
- `apps/agent/test/interview/application.test.ts`：有历史时交接任务仍起 opening Turn 且只消费一次；普通 reply 不消费交接。
- `apps/agent/test/interview/agent.test.ts`：intake opening 带交接任务时使用交接开场，而不是首次开场。
- `apps/agent/test/interview/stepBinding.test.ts`：交接任务只注入 opening，reply 为 `null`。
- `apps/desktop/test/interviewOnboardingStore.test.ts`：`endRehearsal()` 清空标记但保持 `completed`，重复调用幂等。
- `apps/desktop/test/interviewOnboardingIpc.test.ts`：`notify()` 以 `OnboardingChanged` 推送最新状态。
- `packages/ui/test/InterviewDualMode.test.tsx`：收到推送后从演练切回「制作面试分身」并打开 intake 会话。
- `apps/agent/test`（core/interview/conversation 共 105 文件、806 测试）通过；全量 `pnpm verify` 见提交记录。

## 风险

- 模型可能把“用户还没回答完”误判成 `blocked-by-gap`，导致提前切回资料整理；验收时要重点看长时间追问场景，必要时收紧工具描述而不是加代码拦截。
- 交接后 intake 的 opening Turn 依赖模型端点；无端点时任务会留在内存等待下一次打开，用户可能先看到旧的 intake 历史，需要一次显式发送才恢复。
- 辅助模式与演练模式共用同一阶段字段；真实面试中途若误触发交接，会直接离开辅助面板。当前接受该风险，后续若实机反馈频繁，再评估“辅助模式禁止交接”的硬约束。
