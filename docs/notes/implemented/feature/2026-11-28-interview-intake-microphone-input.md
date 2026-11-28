# Note：制作面试分身的语音输入（资料整理会话麦克风）

状态：已实施

## 问题

「制作面试分身 → 面试演练 → 演练结束召唤资料整理者」的文本闭环已经完成，但 `interview.intake` 页面只能打字。用户希望制作分身阶段也能直接用语音讲简历和项目。

此前语音链路有三处假设挡住了 intake：

1. `InterviewRuntime` 绑定单个 `application`，所有音频帧都会结算到演练会话；把 intake 的麦克风接上去会把资料整理内容写进演练 transcript。
2. 桌面 `InterviewChannels.Start` 只放行 `ActiveInterviewConversationId`，intake conversation 会被判为非法。
3. renderer 的 `pcmFrameProcessor.js` 假定输入已经是 16 kHz，且只上报音频帧不上报电平；真实设备普遍是 44.1/48 kHz，直接当 16 kHz 发会让 VAD/ASR 收到错误的帧长。

## 涉及范围

- `apps/agent/src/interview/runtime.ts`：`application` 改为 `resolveApplication(conversationId)`；`startedApplications` 跟踪已开始的会话；`start` / `stop` / `captureFailed` / `failSession` / `dispose` 按会话收口。
- `apps/agent/src/host.ts`：注入 resolver，只有 `ActiveInterviewIntakeConversationId` 走 `interviewIntake`，其余走 `interview`。
- `apps/desktop/src/main/interview/interviewIpc.ts`：`Start` 白名单同时放行演练与 intake conversation ID。
- `apps/desktop/public/pcmFrameProcessor.js`：按 `sampleRate` 做分数相位重采样到 16 kHz；新增 `level`（RMS）消息；电平独立于 credit，丢帧时仍可观测输入。
- `packages/ui/src/interview/voice/useInterviewMicrophone.ts`：新增 renderer 采集 hook，用户手势内申请麦克风、加载 worklet、转发帧与 credit、处理失败与停止。
- `packages/ui/src/interview/intake/InterviewIntakePanel.tsx`：头部加麦克风 `IconButton`；切阶段前先停采集；麦克风错误与对话错误互斥展示。
- 测试：`apps/desktop/test/pcmFrameProcessor.test.ts`、`packages/ui/test/interview/useInterviewMicrophone.test.tsx`、`packages/ui/test/interview/InterviewIntakeMicrophone.test.tsx`。
- 相关 Note：[面试制作分身 → 开始演练的两阶段入口](2026-11-28-interview-preparation-stage.md)、[演练/辅助 Bot 交接给资料整理者](2026-11-28-interview-profile-review-handoff.md)、[面试 intake 对话页与画像补全](2026-11-19-interview-intake-conversation.md)、[面试前引导与候选人档案首次使用流程](../../proposed/feature/2026-11-11-interview-onboarding-and-avatar.md)、[面试麦克风处理的约束](../../implemented/process/2026-10-22-microphone-audio-processing-constraints.md)。

## 决定

1. **语音先接制作分身，演练语音随后**。两阶段里 intake 是用户停留更久、更需要口述资料的一段；先把按会话分流的底座打通，演练复用同一条管线即可。
2. **结算归属按 conversation 解析，不再全局单 application**。runtime 只负责 VAD/ASR/turn 管线；`resolveApplication` 由 host 注入，停止/失败只收口发起该会话的 application，`dispose` 逐个收口。
3. **重采样放在 worklet，不强制 `AudioContext({ sampleRate: 16000 })`**。设备原生采样率经 `start.sampleRate` 下发给 worklet，分数相位重采样到 16 kHz；44.1 kHz 这类非整数比不会被拖成整数帧率。旧实现「拿不到 16 kHz 就报错」的前提由此取消。
4. **电平独立于 credit**。worklet 每次 flush 都发 `level`，即使当前没有 credit、音频帧被丢弃，UI 仍能知道麦克风是否有输入；hook 只把电平作为状态暴露，本轮不做波形 UI。
5. **renderer 只做媒体层**。会话建立、capture-ready、帧校验、agent 侧 credit 与领域写入都沿用既有 bridge/IPC；hook 不持有凭证、不判断阶段、不写 transcript。
6. **麦克风按钮是 header 的 quiet 图标按钮**，`aria-pressed` 反映采集状态；面板唯一 primary 仍是「开始面试演练」。点击开始演练前显式 `stop()` 采集，避免残留帧继续落进 intake；面板卸载时也收口。
7. **credit 有界、失败 fail-closed**。agent 补 credit 只补到 `INTERVIEW_AUDIO_CREDIT_WINDOW`；超过 3 秒没有 credit 且缓冲不足时按采集中断处理，调用 `failInterviewCapture`。合成/识别失败不影响已有的文字对话，只在面板显示一条可恢复的错误。
8. **intake 不自动发声**。TTS 只挂在演练模式的 assistant 回复上；制作分身阶段保留手动朗读，不新增自动朗读开关。

## 影响表面

- 用户行为：制作分身页头多一个麦克风按钮；点击后授权麦克风即可口述资料，全程走 intake 对话与同一份 `profile.xml`。再点一次或切到演练即停止。
- 协议：无新增频道；只复用既有 `Start` / `CaptureReady` / `CaptureFailed` / `AudioFrame` / `AudioCredit` / `Stop`，`Start` 的会话白名单扩大到 intake。
- 持久化：无新增文件；语音结算仍按普通 user 消息与回复落进 intake transcript，画像仍只由 intake 写。
- 模块边界：worklet 只做重采样与电平；Agent runtime 只做管线与结算归属；renderer 只做媒体采集与转发。

## 曾考虑的替代方案

- **把 intake 语音接到现有单个 `application`：** 舍弃。会把资料整理写进演练 transcript，且演练只读画像的权限边界会被绕开。
- **在 renderer 用 `AudioContext({ sampleRate: 16000 })` 让浏览器重采样：** 舍弃。此前正是这个前提导致 48 kHz 设备不可用；浏览器对重采样质量与延迟的控制不如 worklet 明确，也无法同时产出独立电平。
- **用 `AnalyserNode` 单独采电平：** 舍弃。worklet 已经逐帧算出 RMS，单独定时器会重复计算且节拍与帧不对齐。
- **把麦克风按钮做成主操作或加文字标签：** 舍弃。面板已有唯一 primary「开始面试演练」，麦克风是输入方式切换，用 `IconButton` + `label` 更符合原语契约。
- **切阶段时只靠面板卸载收口：** 舍弃。卸载是隐式行为，显式 `stop()` 能保证先停采集再写阶段事实，顺序可断言。

## 后果与防回退

- `resolveApplication` 必须只由 host 注入；runtime 不得猜测 conversation 语义，也不得在 renderer 侧传入 application。
- 新增面试 Agent/conversation 时必须同步更新 host 的 resolver 与 desktop `Start` 白名单，否则语音会结算到错误领域或被拒绝。
- worklet 的 `level` 消息不得被当成 transcript 或持久化事实；它只是 renderer 本地状态。
- credit 上限不得取消：它是防止 agent 停发 credit 时无限缓冲/无限发帧的唯一边界。
- 麦克风按钮保持 quiet；不要在 intake 面板再放第二个 primary。
- 本实现只覆盖 `candidate` 一路；面试官声音（loopback）采集仍未实现，不要把它误标为可用。

## 验证

- `apps/desktop/test/pcmFrameProcessor.test.ts`：16 kHz 帧标签、丢帧仍报电平、48 kHz 重采样、44.1 kHz 分数相位（含尾部 flush）、credit 有界与序号/起点保持，5 项通过。
- `packages/ui/test/interview/useInterviewMicrophone.test.tsx`：用假 `AudioContext`/`AudioWorkletNode`/`getUserMedia` 验证会话与设备采样率、帧 DTO 转发、credit 有界回填、电平上报、停止收口、权限拒绝 fail-closed、bridge 缺失拒绝启动，6 项通过。
- `packages/ui/test/interview/InterviewIntakeMicrophone.test.tsx`：按钮标签与 `aria-pressed`、激活态切换、错误展示、切阶段前先停采集，4 项通过。
- 既有 `test/InterviewIntakePanel.test.tsx`、`InterviewDualMode.test.tsx`、`InterviewOnboardingPanel.test.tsx` 共 23 项通过；agent 面试域 18 文件 99 项通过；agent typecheck 通过。
- 全量 `pnpm verify` 与 `pnpm notes:check` 的结果见提交记录。

## 风险

- 尚未真机验证：麦克风权限、48 kHz 设备重采样后的识别质量、电平波形、3 秒 credit watchdog 是否过紧，都需要 Windows 实机确认。
- 安装版面试入口仍由 `interviewAvailable: !isPackaged` 关闭；worklet 资源随 `public/` 打包与 `document.baseURI` 解析必须在打包版验收一次。
- 演练语音尚未接入；`resolveApplication` 的分流虽已具备，但演练侧仍只有文本输入。
- `interviewIntake` 的文本回复与语音结算共用同一 `replyLoop`；两端的 `start()` / `stop()` 都递增 epoch，极端时序下可能出现一次结算被淘汰。实机若复现，需要把文本与语音的 epoch 拆开。
- 面板卸载时 `stop()` 是异步的；如果主进程在收口完成前已切换阶段，残留帧会被 capture service 的阶段校验丢弃，不会写错会话，但会少最后一句转写。
