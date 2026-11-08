# Note：candidate 语音对话的自动回复与开口打断

状态：已实施

> 当前产品语义已由 [面试语音不打断辅助回答](../bug-fix/2026-11-08-interview-voice-does-not-interrupt-reply.md) 更新：VAD 开口不再取消 AI 回复；只有确认后的 turn 进入排队发送流程。本 Note 中关于开口打断的实现与验证记录是历史决策，不再代表当前行为。

## 问题

面试语音链路已经能把麦克风语音经 VAD、ASR、turn 聚合与 settle 合并写成用户消息，但刻意停在「只入对话、不生成回答」（[面试模式麦克风对话输入](../../proposed/feature/2026-10-22-interview-microphone-conversation-input.md)）。因此当前无法验证真正的实时对话效果：用户说完一句没有回复；回复生成后用户再开口也没有任何打断路径；面试面板只投影 `user` 消息，助手消息即使存在也不显示。

产品方向是先让 candidate（用户自己）把「说完 → 自动回复 → 再开口打断 → 继续识别」整条闭环跑顺，验证交互与延迟；确认后再把回答触发源切到 interviewer。现有实现没有承载这条闭环的状态机：

- `ConversationRuntime.sendChat` 会在启动 run 时一并写入 user message，而 turn 管线当前已经单独 `appendUserMessage`；两条路径同时使用会重复消息。
- `ConversationRuntime.cancel` 只发 abort，没有完成信号；新一回复在旧 run 尚未落账时启动，会被 store 的「当前回复尚未完成」守卫拒绝。
- VAD 流水线把 `speech-started` 折叠进 segmenter 后丢弃，宿主无法在开口瞬间取消在途回复。
- 面试面板只保留 `role === "user"` 的消息，没有助手流式渲染。
- agent 在 `interview-start` 前没有模型配置与令牌来源，自动回复无法启动。

## 涉及范围

- 代码/模块：`apps/agent/src/interview/reply/`（新增 `loop.ts` 与 `policy.ts`）、`apps/agent/src/worker/interviewReply.ts`（新增）、`apps/agent/src/worker/host.ts`、`apps/agent/src/interview/vad/pipeline.ts`、`apps/agent/src/conversation/{runtime,store}.ts`、`apps/desktop/src/main/conversation/agentService.ts`、`packages/ui/src/app/{FloatingBarApp.tsx,interviewConversation.ts,useInterviewConversation.ts}`、`packages/ui/src/components/panels/InterviewCapturePanel.*`。
- UI/进程/协议/持久化表面：不新增 IPC 频道、不改 worker 线协议、不改持久化；面试面板从「只显示用户消息」变为「用户与助手同一条消息流」，助手支持流式与 interrupted 状态。
- 相关 Note：[面试模式麦克风对话输入](../../proposed/feature/2026-10-22-interview-microphone-conversation-input.md)、[candidate 轮次 settle 合并与最小有效轮过滤](./2026-10-22-candidate-turn-settle-merging.md)、[面试语音运行时模块边界](../../proposed/architecture/2026-10-19-interview-runtime-module-boundaries.md)、[turn 端点判定层](../../proposed/architecture/2026-10-22-turn-endpoint-judge-layer.md)、[Answra 实时语音识别私有协议（AVP）v1](../../proposed/architecture/2026-10-16-answra-voice-protocol-avp-v1.md)。

## 决定

### 1. 用户消息与助手运行拆开

turn 管线拥有用户消息，回复只拥有助手回合：

- 新增 `ConversationStore.beginReplyRun(conversationId, runId)`：要求当前没有活动 run，且最后一条消息是已完成的 user 消息；只追加 streaming 的 assistant 消息并认领 run，不重复写 user，同时返回被认领的 user 消息。
- 新增 `ConversationRuntime.replyToLastUserWithProfile(profile, conversationId, getAccessToken)`：按 profile 读取历史，请求文本取认领操作返回的最后一条 user 消息；复用现有模型执行与取消路径。`ChatConversationRuntime.replyToLastUser` 只作为对话侧薄封装。
- 新增 `ConversationRuntime.waitForRun(runId)`：run 的 `finishRun` 完成后 resolve，作为「旧回复已落账」的唯一完成信号。
- 访问令牌在 `execute` 内获取：认领 run 后即使换令牌失败，也按 `start → error → failed` 落账，用户文本不会丢。

认领与取 user 消息在同一步完成，避免「先读快照、再认领」之间插入手动消息导致请求与历史错位。

### 2. 回复状态机

新增 `InterviewReplyLoop`（`apps/agent/src/interview/reply/loop.ts`），只依赖端口：

```ts
interface ReplyLoopPorts {
  appendUserTurn(conversationId, turns, text): Promise<void>
  startReply(conversationId): Promise<{ runId: string }>
  cancelReply(runId): void
  waitForReply(runId): Promise<void>
  onError(stage, error): void
}
```

- `speechStarted(source)`：仅当 `source` 等于配置的触发源时，取消当前 `activeRunId`；不等待、不阻塞音频。
- `turnSettled(conversationId, turns, text)`：按会话串行；先取消并等待任何仍在途的 run，再 `appendUserTurn`；若未停止且场次未切换，随后 `startReply` 并记录 runId。
- 新 run 完成时只在 runId 仍等于 `activeRunId` 时清空，迟到完成不会覆盖新 run。
- `stop()`：取消并等待在途 run；会话失败/停止时调用。`start()` / `stop()` 同时递增 `sessionEpoch`，上一场排队中的结算不会在新场次启动回复。

触发源收敛在领域策略 `apps/agent/src/interview/reply/policy.ts`，本轮固定为 `candidate`；回答 profile 独立在 `apps/agent/src/interview/reply/profile.ts`（`INTERVIEW_REPLY_PROFILE`：`includeHistory: true`、无工具、无时间注入），不借用 `general-chat`。`worker/interviewReply.ts` 只依赖窄端口 `InterviewReplyRuntime`，不 import 对话 runtime 的具体实现；`host.ts` 作为唯一组合根把 `ChatConversationRuntime` 接进去。切 interviewer 时改 policy，并同步放行 interviewer 采集与 assembler（当前至少还有 desktop 采集白名单、agent assembler 两处过滤）；回复状态机与 UI 不改。

### 3. 开口即打断

`InterviewVadPipeline` 增加 `onSpeechActivity` 回调，把 `speech-started` / `speech-ended` 原样投递给宿主。宿主把 `speech-started` 交给 `InterviewReplyLoop.speechStarted`：

- 取消在途模型 run；采集、VAD、ASR 不停止。
- 新一句照常分段、识别、settle；settle 后启动新回复。
- 旧 run 的完成由 store 标记为 `interrupted`，已输出文本保留在消息流中。

### 4. 触发与提交时机

本轮不接端点判定模型：回答触发点仍是现有 VAD 闭合 + `CandidateTurnSettler` 结算窗口。端点判定后续只替换 settler 的输入，不改本状态机。settle 窗口内连续碎句仍合并成一条用户消息，再统一回复。

### 5. 面试面板

- 新增纯投影 `packages/ui/src/app/interviewConversation.ts`：把 `ConversationChange` 折叠成 `{ id, role, text, status }` 列表，支持 snapshot、messages-appended、text-delta 与 run-finished。
- 新增 `useInterviewConversation` 承载订阅与投影，`FloatingBarApp` 只消费视图；`InterviewCapturePanel` 按角色渲染 user / assistant 气泡，assistant 显示 streaming / interrupted / complete 状态。
- 自动回复失败来自现有 `ConversationChange` 的 `error` 事件，投影后由面板现有错误提示展示，不新增 IPC。手动发送失败留下的本地错误会在新的 assistant 回合开始时清除。

### 6. 模型准备

`AgentService.startInterview` 在发送 `interview-start` 前解析并下发模型配置（与普通发送同一 `resolveModel` + `ensureConfigured`）。未登录或未配置时面试启动显式失败（`auth-required` / 配置提示），不静默进入「只采集不回复」状态。

### 7. 并发与可见性收口

实现落地后补齐以下时序与边界缺口：

- **开口序号**：`InterviewReplyLoop` 维护 `speechEpoch`，触发源每次开口都递增（即使当时没有 active run）。`settle` 在等待旧 run、追加用户消息前记录 epoch；`startReply` 拿到 runId 后若 epoch 已变化或会话已停止，立即取消该迟到 run。这样「取令牌期间用户又开口」和「追加用户消息期间用户又开口」都不会留下未取消的回复。
- **令牌失败可见**：`replyToLastUser` 只负责认领 assistant turn 并返回 runId；访问令牌改在 `execute` 内获取。换取失败按 `start → error → failed` 落账，UI 能展示失败轮，而不是启动一个没有下文的 run。
- **手动输入收口**：助手消息 `status === "streaming"` 时禁用发送但保留输入框；`onSendText` 返回 Promise，追加成功后才清空草稿，失败保留草稿。新的 assistant 回合 `messages-appended` 到达时清除上一轮 `error`，用户消息追加不清错。
- **场次隔离**：`InterviewReplyLoop` 维护 `sessionEpoch`，`start` / `stop` 都递增；`turnSettled` 捕获排队时的场次，旧场次结算只落用户消息，不再启动回复。
- **认领与请求对齐**：`beginReplyRun` 返回被认领的 user 消息，runtime 直接用它构造请求；不再先读快照再认领，避免并发手动消息造成请求错位。
- **本地空令牌**：宿主反向令牌请求只有显式 `error` 才算失败；本地端点返回空字符串是合法的「无 Authorization」状态，不能被当作拒绝。
- **领域 profile 解耦**：面试使用自己的 `INTERVIEW_REPLY_PROFILE`，不读取 `CHAT_PROFILES`；`ConversationRuntime.replyToLastUserWithProfile` 接受领域自持的 profile，`ChatConversationRuntime` 仅作为对话侧的薄封装。`interviewReply.ts` 的端口只要求 `appendUserMessage` / `replyToLastUserWithProfile` / `cancel` / `waitForRun`。

## 影响表面

- 用户可见：candidate 说完后自动出现助手回复；助手流式输出；用户再次开口时助手回复停止，旧内容标记 interrupted，新一句继续识别。
- 消息事实来源不变：user/assistant 仍由 `ConversationRuntime` 写入，Agent 进程内存保存。
- 面试启动条件变化：现在需要可用的模型来源；仅采集不回复的模式不再存在。
- 自动化验证：回复状态机、store 原子认领、runtime 完成信号、UI 投影与面板渲染。

## 曾考虑的替代方案

- **只调用 `sendChat`，不单独 append：** 舍弃。`beginRun` 在模型未配置时先抛错，用户刚说的话会连同 run 一起丢失；且与手动文本路径重复写 user。
- **保留 append，然后 `sendChat` 传空文本：** 舍弃。会产生一条空的 user 消息进入历史。
- **在 desktop main 监听 turn 事件并触发回复：** 舍弃。开口打断需要 VAD 活动，而活动事件留在 agent；把触发策略放 desktop 会让「何时回答」分裂成两个真相点。
- **用 `reply-invalidated` 事件表达打断：** 本轮不做。该事件当前没有消费者，且回答失效的可观察事实已经是 store 的 `run-finished(interrupted)`；不新增无人消费的线协议字段。
- **在 UI 层合并/推导消息角色：** 舍弃。角色和状态必须来自 ConversationChange；UI 只做渲染。
- **本轮接端点判定模型：** 暂缓。先把自动回复与打断闭环跑通；settle 窗口的延迟与误合并仍需真实样本校准。

## 验证

- `pnpm --filter @answra/agent test`：133 passed；覆盖 `beginReplyRun` 原子认领/返回 user、token 失败落 `failed`、`waitForRun`、`speechEpoch`、`sessionEpoch`、空 token、宿主自动回复。
- `pnpm --filter @answra/ui test`：212 passed；覆盖消息投影、助手流式/打断状态、streaming 时禁用发送、失败保留草稿、新 assistant 清除旧错误。
- `pnpm --filter @answra/shared test`：3 passed；`pnpm --filter @answra/desktop test`：277 passed。
- `pnpm notes:check`、`pnpm verify`：通过；`pnpm verify` 包含 biome、全包 typecheck、vitest 与 architecture check。
- 未完成：Windows 麦克风连续两轮实机验证，确认打断延迟、无重复消息、无音频中断；未实测前不宣称现场对话体验达标。

## 后果与防回退

- 用户可见结果：candidate 完成一轮语音后自动出现助手消息并流式增长；再次开口时旧回复停止并标记 interrupted，新一句继续识别与回复。
- 旧 run 落账延迟会阻塞下一轮：新回复必须等 `waitForRun`；若供应商不响应 abort，下一轮会排队。当前不静默跳过，后续需要时再加可观测超时。
- settle 窗口误合并、短轮被吞仍是既有取舍；端点判定模型接入前不作为本流程回归。
- 打断发生在 VAD 判定为语音之后，咳嗽/环境噪声也可能取消回复；阈值仍需实机校准。
- 自动回复依赖登录或可用模型配置；这是有意的启动门禁，不恢复「只采集不回复」的静默降级。
- 防回退：`beginReplyRun` 必须继续原子校验「无活动 run + 最后一条是完整 user + 返回该 user」；`sessionEpoch`/`speechEpoch` 缺一都会让旧场次或开口后的迟到 run 复活；宿主令牌应答不得把空字符串当作失败。
- 防回退：面试仍使用 `INTERVIEW_REPLY_PROFILE`，不得回退到 `CHAT_PROFILES` 或 `sendChat`；否则会重新引入重复 user 消息与工具泄漏。
- 助手消息进入面试历史是当前已接受的事实；若产品要求「建议不写入历史」，必须另行定义投影与存储边界，不能在本流程里临时过滤。
