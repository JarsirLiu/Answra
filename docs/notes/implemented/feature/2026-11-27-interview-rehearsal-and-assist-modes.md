# Note：面试演练与辅助双模式及面试辅助教练 Bot

状态：已实施

## 问题

面试面板完成引导后目前直接进入 `interview.intake` 资料整理对话（`InterviewFeaturePanel.tsx:44-52`），用户看不到“演练”和“辅助”两种场景的区分。现有 `sendInterviewMessage` 实际走的是 `interview.rehearsal`（面试官身份，`agentService.ts:184-196` → `interview-message`），因此**只在 UI 上加两个图标切换不会产生真实的辅助行为**，会制造没有协议来源的假状态。

用户明确的产品意图：面试域内提供两个模式——演练（AI 扮演面试官提问、追问、点评）与辅助（AI 作为教练，根据用户输入的面试官问题给出回答建议）；用“面试官”和“候选者”两种图标切换；辅助模式本轮先做文本输入，不接系统声音与 TTS。

## 涉及范围

- 代码/模块：
  - `packages/shared/src/channels/interview.ts`、`packages/shared/src/bridge.ts`：新增演练/辅助的 open/message/snapshot 频道与固定会话 ID。
  - `apps/agent/src/worker/protocol.ts`：新增显式命令，不复用会话 ID 推断场景。
  - `apps/agent/src/interview/coach/`：新增 `interview.coach` Agent 的 prompt 与只读工具授权。
  - `apps/agent/src/host.ts`：注册第三个面试 Agent 与第三个 `InterviewApplication`，接命令并做生命周期收口。
  - `apps/desktop/src/main/agent/agentService.ts`、`apps/desktop/src/main/interview/interviewIpc.ts`、`apps/desktop/src/preload/index.ts`：显式命令、固定会话、sender 校验与转发。
  - `packages/ui/src/app/InterviewFeaturePanel.tsx`、`packages/ui/src/interview/chat/`：面试面板内的子模式切换、两个聊天页与共享文本会话 hook。
  - `packages/ui/test/`：子模式切换与两个 Bot 路由的行为测试。
- UI/进程/协议/持久化表面：
  - 顶层 `Mode` 仍是 `conversation | exam | interview`；子模式只在面试面板内切换，不改顶层导航与 `panel === "interview"` 产消链路。
  - 演练使用 `ActiveInterviewConversationId` 与 `interview.rehearsal`；辅助使用新的 `ActiveInterviewAssistConversationId` 与 `interview.coach`；资料整理继续使用 `ActiveInterviewIntakeConversationId`。三份 transcript 不互通。
  - 辅助本轮只做“文本输入面试官问题 → coach Bot 给文字建议”，不采集系统声音、不合成 TTS、不做语音轮次打断。
- 相关 Note：
  - [面试前引导与候选人档案首次使用流程](../../proposed/feature/2026-11-11-interview-onboarding-and-avatar.md)
  - [面试向导、候选人与演练三 Agent 分工](../../proposed/architecture/2026-11-11-interview-three-agent-boundaries.md)
  - [面试 intake 对话页与画像补全](2026-11-19-interview-intake-conversation.md)
  - [面试语音识别管线与客户端 VAD 选型](../../proposed/architecture/2026-10-16-interview-asr-pipeline-and-vad.md)
  - [产品方向与 Agent 底座](../../proposed/architecture/2026-10-20-product-direction-and-agent-foundation.md)

## 决定

1. **子模式而非顶层模式**：在 `InterviewFeaturePanel` 内用两个图标按钮切换“演练 / 辅助”；面试官语义用 `Bot`，候选者语义用 `User`。两者互斥，`aria-pressed` 表达选中态，沿用 `SettingsPanel` 的 segmented 范式，不扩 `MODES` / `ModeDefinition`。
2. **两种模式各有真实 Agent 与命令链**：
   - 演练：`interview-message` / 新增 `interview-rehearsal-open`，executor 为 `interview.rehearsal`，只读画像，以面试官身份提问与点评。
   - 辅助：新增 `interview-assist-open` / `interview-assist-message` / `interview-assist-snapshot`，executor 为新增的 `interview.coach`，只读画像，基于候选人档案与用户输入的面试官问题给出第一人称回答建议。
3. **画像写入仍只归 `interview.intake`**；coach 与 rehearsal 都只读 `profile.xml`，renderer 不注入 prompt、工具或文件路径。
4. **辅助不做语音/TTS**：`2026-10-16-interview-asr-pipeline-and-vad.md` 排除 TTS 的结论适用于“听 + 文字建议”的辅助场景，本轮保持；演练模式的 TTS 若要做，另立 Note 收窄该结论的适用范围。
5. 三个面试会话各自有固定 ID，由主进程/UI 使用常量，renderer 不传任意 `conversationId`。

## 影响表面

- 面试面板完成引导后只显示子模式切换条与对应聊天页；头部不再有“资料”/“重试”按钮，资料整理会话由 `interview.intake` 保留但不再从面板进入（见[面试打开门禁与头部精简](../bug-fix/2026-11-27-interview-open-without-model-gate.md)）。
- 切换子模式只改变当前展示的会话与发送命令，不启动/停止音频采集，不取消另一模式的在途 run；两个页面各自按 snapshot/事实帧恢复自己的消息流。
- `interview.coach` 进入 `AgentRuntime` 静态注册表；因现有面试 Bot 不在 Conversation catalog 中，本轮不改 Bot 选择器与团队预置。
- 顶层导航测试、模式可用性规则不受影响。

## 曾考虑的替代方案

- **只加 UI 图标切换，两个模式共用现有 `interview.rehearsal`：** 舍弃。没有独立 Bot/命令，`aria-pressed` 会表达一个不存在的状态，违反显式状态来源原则。
- **保留一个 Agent，在 prompt 里按模式切换身份：** 舍弃。`2026-11-11-interview-three-agent-boundaries.md` 已论证面试官与教练的目标、语气和权限冲突，且 renderer 不得注入 prompt。
- **把演练/辅助扩成顶层 `Mode`：** 舍弃。会牵动 `ModeDefinition`、`applyModeAvailability`、悬浮条模式菜单和现有导航测试，而两者仍属于同一个面试产品面。
- **本轮接系统声音 loopback 与 TTS：** 舍弃。前置是桌面采集放行 `interviewer` 源、`InterviewChange` 投影和真实音频验收；当前均未完成，且与本轮要验证的 prompt/会话质量无关。

## 后果与防回退

- 新增 Bot 必须继续走 `AgentRuntime.registerAgent` 静态注册；不得由 renderer 传 prompt、工具或发现关系。
- 任何面试模式都必须有显式命令 + 固定 conversation ID；禁止用会话 ID 前缀或字符串推断场景。
- `interview.coach` 与 `interview.rehearsal` 都不得写 `profile.xml`；画像写入口只有 `interview.intake`。
- 若后续引入 TTS，只允许在演练模式发声；辅助模式在真实面试官说话时不得语音插话。
- 切换子模式不得复用或清空另一模式的 transcript；三份会话各自恢复。

## 验证

- 自动化验证：`packages/ui/test/InterviewDualMode.test.tsx` 覆盖两个图标的互斥选中态、点击后渲染对应聊天页与发送命令；`apps/agent/test/worker/host.test.ts` 覆盖 assist open/message/snapshot 走独立会话。在 Node 22.19.0 + pnpm 11.9.0 上 `pnpm verify` 全绿（UI 365/365、Agent 829/829），静态门禁与 Note 检查均通过。
- 需要实机验证：桌面端完成引导后切换两次模式，分别输入“面试官问题”并确认演练页出现面试官提问、辅助页出现回答建议；两个会话互不串消息。该验收由使用者在 Windows 桌面端完成，自动化不替代。

## 风险

- 新增 3 个 worker 命令与 1 个会话 ID，协议面扩大；通过显式命令与固定 ID 约束，不引入动态选择器。
- 辅助质量依赖 `profile.xml` 的完整度；跳过引导时 coach 只能基于用户当轮输入给建议，需明确的提示文案。
- 两个模式共用 `useConversationView` 的会话投影；切换时必须按各自 conversation ID 重绑，否则会把一个会话的帧折叠到另一个视图。
