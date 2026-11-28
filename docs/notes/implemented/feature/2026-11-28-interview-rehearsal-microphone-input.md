# Note：面试演练的麦克风语音输入

状态：已实施

## 问题

制作分身的语音输入已经接通，但「面试演练」仍只能打字。演练的核心是面试官用语音提问、用户口头回答；缺麦克风输入时，TTS 虽然能让面试官发声，用户却要停下来打字，角色感和节奏都被打断。

同时必须守住两条边界：面试辅助只在真实面试官说话时给文字建议，任何情况下不得因语音能力插话；演练结束后由 Bot 召唤资料整理者切回制作分身，切阶段不能留下仍在采集的麦克风。

## 涉及范围

- `packages/ui/src/interview/chat/InterviewTextChatPanel.tsx`：复用 `useInterviewMicrophone`，演练模式头部加麦克风按钮；开麦前打断 TTS；麦克风错误与 TTS 失败共用窄提示。
- `packages/ui/src/interview/chat/chat.css`：演练麦克风电平条，只消费语义令牌。
- `packages/ui/test/interview/RehearsalMicrophone.test.tsx`：按钮、打断、电平、辅助模式隔离与错误展示。
- 复用而不改动：[制作面试分身的语音输入](2026-11-28-interview-intake-microphone-input.md) 的 worklet、采集 hook 与 Agent runtime 会话分流；[面试演练模式语音合成](../../proposed/feature/2026-11-27-interview-rehearsal-tts.md) 的自动朗读与取消链路。
- 相关 Note：[面试演练与辅助双模式](2026-11-27-interview-rehearsal-and-assist-modes.md)、[演练/辅助 Bot 交接给资料整理者](2026-11-28-interview-profile-review-handoff.md)。

## 决定

1. **演练复用同一条采集管线**。`useInterviewMicrophone` 以 `ActiveInterviewConversationId` 启动；音频仍由 worklet 重采样成 16 kHz，按 conversation 解析回 `interview` application，结算成演练 transcript 的 user 消息并触发演练官回复。不为演练复制第二套采集逻辑。
2. **按钮只在演练模式出现**。辅助模式不渲染麦克风入口，结构上也就不存在「辅助插话」的用户路径；两个模式由 `key={mode}` 重挂载，切模式时旧 hook 的卸载收口会停采集。
3. **开麦即打断朗读**。点击开始时先 `stopTts({ conversationId: ActiveInterviewConversationId })`：主进程中止在途合成与待播段、广播 `Stopped`，渲染层清空播放队列；随后才启动采集。反过来停止麦克风不会重置 TTS 状态。
4. **电平条显示真实输入**。worklet 逐帧给出的 RMS 直接决定进度条宽度，用 `--mint` 作为进度面，不给图标或文字上色；不是装饰性波形动画。
5. **失败 fail-open**。麦克风权限/设备错误进入面板的同一条窄提示，不阻塞文字输入与已有回复；切阶段或关面板时采集随卸载收口，主进程的交接收口也先停采集。
6. **自动朗读仍只属于演练**。辅助模式不发 TTS 文本增量；手动「朗读」是独立链路；本变更不新增朗读开关，也不让 intake 自动发声。

## 影响表面

- 用户行为：演练页头多一个麦克风按钮与电平条；点击后口述回答，开麦时面试官朗读立即停止；再点一次、切到辅助或切回制作分身都会停采。
- 协议：无新增频道；复用 interview 采集频道与 TTS `Stop` 频道。
- 持久化：语音结算按普通 user 消息与回复落进演练 transcript；不改 `profile.xml`，不改阶段字段。
- 模块边界：renderer 只管媒体与按钮；Agent 仍只做领域结算；desktop 只校验转发，不代执行工具。

## 曾考虑的替代方案

- **在 `FloatingBarApp` 顶层挂一个全局麦克风按钮：** 舍弃。按钮会跨演练/辅助/制作分身常驻，模式隔离只能靠运行时判断，容易把录音带到辅助模式。
- **辅助模式也放麦克风入口：** 舍弃。用户明确要求辅助模式不得插话；没有入口比靠 prompt 禁止更可靠。
- **用一个装饰性波形代替真实电平：** 舍弃。worklet 已经给出 RMS，假波形会让用户无法判断麦克风是否真的收到声音。
- **开麦时只停渲染层播放、不通知主进程：** 舍弃。在途合成会继续占用 Key 并稍后推来音频帧，必须让 `ttsService.stop()` 一并 abort。

## 后果与防回退

- 麦克风按钮必须保持 quiet，演练页不得出现第二个 primary；模式切换按钮仍是唯一选中态表达。
- `stopTts` 必须传演练 conversation ID；传 `null` 会停止所有会话的朗读，影响手动朗读。
- 电平条只消费令牌；不要把 `--mint` 用到图标、文字或描边前景。
- 辅助模式不得因为任何后续改动获得麦克风按钮或 TTS 自动增量；`RehearsalMicrophone.test.tsx` 的辅助模式用例会拦截。
- 切阶段收口顺序仍是主进程先停采集、再结束演练、再广播状态；不要把这个顺序挪到渲染层推演。

## 验证

- `packages/ui/test/interview/RehearsalMicrophone.test.tsx`：演练按钮标签与 `aria-pressed`、开麦前打断 TTS、激活态显示真实电平、辅助模式无麦克风且无 TTS 停止调用、错误不阻塞输入，4 项通过。
- 既有 `InterviewDualMode.test.tsx`、`InterviewIntakePanel.test.tsx`、`test/interview/useInterviewMicrophone.test.tsx`、`test/interview/InterviewIntakeMicrophone.test.tsx` 无回归；UI typecheck 通过。
- 全量 `pnpm verify` 退出码 0（ui 417、agent 855、desktop 401/2 skipped、cli 414、shared 72、tts 60、config 21、remote 48、mobile 6、remote-node 4、credentials 7）；`pnpm notes:check` 退出码 0。

## 风险

- 尚未真机验证：麦克风权限、面试官语音与用户开口的打断时序、电平条在真实输入下的观感、长时间追问的 credit 稳定性。
- `stopTts` 是异步 IPC，而采集立即启动；极端时序下可能有最后一两个音频帧在 `Stopped` 到达前被播放。实机若明显，需要在渲染层开麦时先本地停播放再发 IPC。
- 演练与制作分身共用 `InterviewCaptureService` 的单活动采集；两端都已显式停采，但若主进程收口失败，第二个会话会被「采集已启动」拒绝，需靠 IPC 错误提示发现。
- 安装版面试入口仍由 `interviewAvailable: !isPackaged` 关闭；打包版 worklet 路径、VAD/ASR 资源与 TTS Key 都还需要实机验收，未完成前不得宣称演练语音在安装包可用。
