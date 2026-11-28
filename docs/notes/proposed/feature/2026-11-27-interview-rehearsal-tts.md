# Note：面试演练模式语音合成（TTS）

状态：提案

## 问题

面试演练模式的 assistant 回复（面试官提问、追问、点评）目前只有文字。用户希望演练时「面试官」能发声，而辅助模式继续只给文字建议、不得在真实面试官说话时插话。

仓库当前没有任何播放能力：全仓无 `AudioContext` / `HTMLAudioElement` / `speechSynthesis` / 音频输出 IPC；通用消息操作的「朗读」菜单项是空操作（`packages/ui/src/components/chat/MessageActions.tsx:409-412,492-500`，另一处 `panels/message-actions/MessageActions.tsx:524-527,638-646` 同样为空且当前无引用）。[已完成的回复操作](../../implemented/feature/2026-10-12-completed-reply-actions.md):23,32 明确「真实朗读不在本次范围」「无后端回调不应视为已接入」。

既有 TTS 排除结论需要收窄：[面试语音识别管线与客户端 VAD 选型](../architecture/2026-10-16-interview-asr-pipeline-and-vad.md):19 写「只使用 ASR + 既有文本 LLM，明确排除 TTS 与 Omni」，该结论针对的是「听系统声音 + 文字建议」的**面试辅助**场景，不应覆盖演练模式。[双模式 Note](../../implemented/feature/2026-11-27-interview-rehearsal-and-assist-modes.md):39,54,61 已预告「演练模式的 TTS 若要做，另立 Note 收窄该结论适用范围；若引入 TTS 只允许演练发声」。

本轮不改动语音识别与 turn 时序（用户 2026-11-27 决定暂缓），TTS 只挂在 assistant 文本回复上。

## 涉及范围

- 代码/模块：
  - 新增 `packages/tts/`（Node-only 宿主无关库）：协议 adapter、切句与 Markdown 净化、合成策略；架构见 [宿主无关的 TTS provider 架构](../architecture/2026-11-28-tts-provider-architecture.md)。
  - `packages/shared/src/tts/`、`packages/shared/src/channels/tts.ts`：朗读意图（文本增量）、provider 配置、策略枚举、音频帧 DTO 与频道；不新增 `DesktopCapability` 云端能力位（首版不走云端）。
  - `apps/agent/src/interview/tts/`：只判断「仅演练、哪些正文可读」，按 `{ conversationId, messageId, sequence, delta, final }` 发文本增量；不切句、不做合成、不持凭证。
  - `apps/desktop/src/main/tts/`：`ClientConfig.tts` 读写、`createSystemModelCredentialStore({ account: "tts-api-key:<providerId>" })` 取 Key、把增量攒成流交给 speaker、IPC 与音频字节转发；不走 `ModelRouter.resolve()`。
  - `packages/config/src/tts.ts`：非 secret 的单一 provider；旧列表格式读取时迁移，不再保存开关与策略。
  - `packages/ui/src/components/chat/MessageActions.tsx`、`AssistantMessage.tsx`、`packages/ui/src/components/panels/ChatPanel.tsx`、`packages/ui/src/interview/chat/`、`packages/ui/src/tts/`：接通 `onAloud` 并新增播放、去重、取消。
- UI/进程/协议/持久化表面：新增 `answra:tts:*` 频道与 `tts-speak` worker 事件；音频字节只在 desktop main → renderer 传递且有界，renderer 永不接触凭证；不写 transcript、不改会话存储；播放状态属于 UI，不新增 durable 状态帧。
- 相关 Note：
  - [宿主无关的 TTS provider 架构](../architecture/2026-11-28-tts-provider-architecture.md)
  - [面试演练与辅助双模式](../../implemented/feature/2026-11-27-interview-rehearsal-and-assist-modes.md)
  - [面试演练与面试记忆](../../implemented/feature/2026-11-10-interview-rehearsal-and-memory.md)
  - [面试语音识别管线与客户端 VAD 选型](../architecture/2026-10-16-interview-asr-pipeline-and-vad.md)
  - [已完成的回复操作](../../implemented/feature/2026-10-12-completed-reply-actions.md)
  - [未登录失败提示的两条模型配置路径](../../implemented/feature/2026-11-27-auth-notice-two-paths.md)

## 提案

1. **收窄排除结论**：`2026-10-16-interview-asr-pipeline-and-vad.md:19` 的「排除 TTS」限定为面试辅助（听系统声音 + 文字建议）场景。演练模式允许发声；辅助模式任何情况下不得因 TTS 在真实面试官说话时插话。
2. **凭证与 provider：首版走用户自己的 API（BYO Key），不经云端转发；架构支持多 provider**。用户 2026-11-27 决定云端暂不做 TTS——走云端登录态就必须在 Answra 服务端加一道 TTS 转发，成本高于收益。首版由用户在设置里配置 provider（`baseUrl` + `model` + `voice` + API Key），Key 写 OS keychain，desktop main 注入合成库，renderer 永不接触。协议/厂商分层与目录结构见 [宿主无关的 TTS provider 架构](../architecture/2026-11-28-tts-provider-architecture.md)。已核对事实：
   - MiniMax `speech-2.8-turbo` / `speech-2.8-hd`：airi 实际使用**原生** `POST /v1/t2a_v2`（SSE 或一次性 hex），不是 OpenAI 兼容 `/v1/audio/speech`；鉴权 `Authorization: Bearer`，必须检查 `base_resp.status_code`（HTTP 200 也可能拒绝）。首版默认 provider 用它。
   - 阿里云百炼 `qwen-audio-3.1-tts-flash` / `cosyvoice-v3-flash`：DashScope 原生端点 `.../api/v1/services/audio/tts/SpeechSynthesizer`，非流式返回音频 URL、SSE 返回 Base64 块；新语音模型不支持 OpenAI 兼容端点，首版走 `openai-compatible` 只能覆盖 `qwen-tts-flash` 等部分模型。
   - **TTS 端点必须独立配置，不能复用本地模型 `baseUrl`**：`ModelRouter.resolve()` 里 chat 与 answer 共用同一个 `view.baseUrl`（`modelRouter.ts:106-107`），TTS 服务端点是另一回事；复用会导致「配了本地 chat 就没法用自己的 TTS」。
   - 结论：**BYO Key 只保证 Key 来源，不保证端点格式**；必须按具体模型实测端点、鉴权、响应格式与计费单位。
3. **触发时机：agent 在 assistant 正文产出时发文本增量，切句由合成库完成**。agent 只挑正文（不读工具调用、思维链、系统提示），按 `{ conversationId, messageId, sequence, delta, final }` 发 `tts-speak`；`packages/tts` 的 `sentence-pipeline` 策略边收边切、有界并发、按 `sequence` 产出音频。首版可先在文本结算处发一条 `{ delta: 全文, final: true }`（行为退化为整段），之后改逐帧**不需要改协议、不需要换策略**。不在 UI 触发：UI 拿不到稳定 `messageId`，且 `useConversationView.ts:161-185` 会重放历史帧/snapshot，会读到半截文本或重复朗读。
   - 为什么不整段合成：300 字点评的文本生成约 6–8 秒，整段再合成等于 7–9 秒静音；分段流水线把首字压到「第一句 + 一次合成」。自动朗读固定流水线，手动朗读固定整段，用户无需选择策略。
   - 切句阈值初始参照 airi `tts-chunker`：前 2 段允许在逗号处提前结束、最短 4 词、最长 12 词；真实值用 Key 实测后定。
4. **手动朗读是独立链路**：把 `act("aloud")` / `more("aloud")` 空操作接成真 `onAloud` prop，一路透传 `AssistantMessage` → `ChatPanel` → 面试聊天页；整段文本以单 delta 走 `whole-text` 策略（一次请求、无段间间隙）。它不得代替自动朗读。
5. **播放取消**：切换演练/辅助模式、停止会话、新 run 启动时，由 desktop `ttsService` 按 `conversationId` 触发 `AbortSignal`，同时在途请求、待合成段、待播段一起停止，并广播 `TtsChannels.Stop` 让 renderer 停止播放、清理 Blob URL；复用现有 Run 生命周期，不新造取消机制。airi 的 `packages/pipelines-audio/src/speech-pipeline.ts` 以 `turnId` + `AbortController` + priority 管打断，可作为组织方式参考，不照搬其实现。
6. **明确不做**：辅助模式发声；Answra 服务端转发 TTS 请求或下发云端 TTS 令牌；renderer 接触任何 token（含用户自己的 TTS Key）或解密桌面 `safeStorage`；CLI 读取桌面凭据；把 TTS 做成 Agent 工具或由 desktop 反向 RPC 代执行；把音频写盘或进 transcript；首版做 STT；provider 音频级流式（SSE 边合成边播）。文本分段流水线在范围内。

## 影响表面

- 用户行为：保存 TTS provider 后，演练模式的面试官回复自动发声；未配置即保持文字模式，没有单独的朗读总开关。消息操作里的「朗读」成为真实动作；切换模式或停止时播放立即中止。
- 协议：新增 `answra:tts:*` 频道与 delta 形状的 `tts-speak` worker 事件（`conversationId`、`messageId`、`sequence`、`delta`、`final`）；**不新增** `DesktopCapability` 云端能力位（首版 BYO Key 不走云端）；TTS 配置不经 worker `configure` 注入 agent——agent 只发文本增量，合成在 desktop main；不改现有 interview 命令，不新增 durable 状态。
- 与 turn 链路的关系：本变更不修改 VAD、ASR、端点判定、settle 或「确认后才发消息」语义；自动朗读跟随 assistant 正文产出，与用户语音何时封口无关。
- 计费：用户自有 Key 直接对 provider 计费（按字符/百万 tokens，单位随模型），Answra 不经手账单；需在用量与错误提示中可观测，失败不得阻塞文字回复。

## 模块边界

- `packages/shared`：只放朗读意图（文本增量）、provider 配置视图、策略枚举、音频帧 DTO 与频道常量；不放 wire 细节、不放音频字节处理、不放 Key。
- `packages/tts`（新增）：放协议 adapter、切句与 Markdown 净化、合成策略（`whole-text` / `sentence-pipeline`）、注册表与错误归一；不依赖 Electron / Node 内置 / Agent / config / credentials，`fetch` 可注入；不读环境变量。
- `apps/agent/src/interview`：只判断「仅演练、哪些正文可读」并发文本增量；不切句、不做合成、不持凭证。
- `apps/desktop/src/main/tts`：持有设置与 keychain、把增量攒成流交给 speaker、IPC 与字节转发；不切句、不排序；**不走 `ModelRouter.resolve()`**（那条路是 chat/answer 的本地或云端令牌）；Key 不下发 renderer。
- `packages/ui`：接 `onAloud` 回调与播放状态，负责实际播放与按 `messageId+sequence` 去重；不判断 provider、不判断策略、不解析文本语义、不持凭证。
- `packages/config` / `packages/credentials`：`ClientConfig` 新增独立的 `tts` 段（不塞进 `model.local`，因为端点不同），只含单一 provider；策略由运行时按来源固定，不写盘，也不再有朗读总开关。Key 用独立的 `tts-api-key:<providerId>` account，与 `local-model-api-key` 隔离（`packages/credentials/src/index.ts:40-44` 已支持 `options.account` 覆盖，无需改该包）；不得承载云端登录令牌。BYO Key 不受 `local-model` 发布功能位限制，但是否在 full 包暴露 TTS 设置入口由发布清单决定。

## 曾考虑的替代方案

- **浏览器 `speechSynthesis`（Web Speech API）**：舍弃。改动最小，但中文音色随 Windows 语音包变化、full 包音色不一致，且绕开仓库既有的 provider 选型 + 凭证 + 能力位体系；仅可用于交互验证，不进产品。
- **直接复用现有 Chat `baseUrl` + `apiKey` 打 `/v1/audio/speech`**：舍弃。百炼兼容端点只覆盖部分模型（新语音模型明确不支持），MiniMax 实际走原生 `/v1/t2a_v2` 而非兼容端点；必须按模型实测端点与响应格式，不能把「Chat 是 OpenAI 兼容」外推到语音。
- **合成放 `apps/desktop/src/main/tts`（不新增包）**：舍弃。改动最小，但 `apps/cli` 将来无法复用；用户明确要求 CLI 也能支持，故抽出 `packages/tts`。详见架构 Note。
- **云端统一选型 + 服务端转发 TTS**（2026-11-27 用户提出并舍弃）：由 Answra 服务端持有 provider Key、下发令牌或转发音频请求，UI 不暴露配置。舍弃理由：需要给服务端新增转发链路与计费归属，成本高于收益；用户明确要求先走自己的 API。云端档位推迟，且不为它预留半成品抽象。
- **在 UI 拿到消息后触发朗读**：舍弃。流式 delta 会反复重渲染，`useConversationView` 会重放历史帧；会读到半截文本或重复朗读老消息。
- **等全文再合成（不做分段）**：舍弃为默认。300 字点评的文本生成约 6–8 秒，整段再合成等于 7–9 秒静音；分段流水线把首字压到 1–2 秒。`whole-text` 仍保留给手动朗读。
- **把切句/并发/排序放宿主**：舍弃。desktop 与 CLI 会各写一遍，且策略与协议重新耦合；放 `packages/tts` 后换策略只是配置变化，三端不改。
- **首版做本地 sherpa-onnx TTS**：舍弃为后续档位。`sherpa-onnx-node` 当前 d.ts 只声明 `OfflineRecognizer`（`apps/desktop/src/main/interview/sherpaOnnxNode.d.ts:1-3`），需扩声明、资源清单与打包；随包体积增加，收益低于先打通云端链路。
- **把 TTS 做成 Agent 工具或桌面反向 RPC**：舍弃。违反「Agent 工具在 Agent 进程执行、desktop 不代执行工具」的边界，也会把凭证暴露到错误的一侧。
- **只保留文字、不做 TTS**：舍弃。演练模式的核心是面试官陪练，缺声音使角色感与体验不完整；辅助模式仍保持纯文字。

## 实施进度

- 已落：`packages/shared` 的 `answra:tts:*` 频道、`TtsSpeakIntent` 增量形状、provider 视图与策略枚举；`packages/config` 独立 `tts` 段（只有单一 provider，旧列表格式读取时迁移）；`packages/credentials` 的 `tts-api-key:<providerId>`。
- 已落：`packages/tts`（adapter + 切句净化 + 两种策略 + speaker）、`apps/agent`（仅演练发正文增量）、`apps/desktop/src/main/tts`（设置/keychain/合成/取消/IPC）、`packages/ui`（播放去重、`onAloud` 菜单、设置分组）。
- 已落：取消路径覆盖「切换模式」「发送新消息」「点停止」；失败只给一条可关闭提示，文字回复不受影响。
- 已落：`chat-audio` 协议 + `mimo` 预设（小米 MiMo TTS，限时免费），作为首个实机验证目标；设置页切协议自动回填端点与默认音色。
- 已落：厂商目录 `TTS_PROVIDER_CATALOG`（MiniMax / MiMo / OpenAI）；设置页用带品牌图标的供应商下拉直接展示单一 provider 表单，与「模型」分组一致。预设厂商不显示端点，协议与端点只作为自定义入口保留；API Key 字段带厂商控制台的「获取 API Key」跳转；保存 provider 即自动朗读，没有单独开关。配置形状、图标与字段取舍见 `docs/notes/implemented/feature/2026-11-28-tts-provider-settings.md`。
- 待办：真实 TTS Key 的实机验收（音色、首字延迟、provider 错误提示、打断体验）与 keychain 不可用场景的桌面实测；未完成前本 Note 保持 `proposed`。

## 验收标准

- 可观察结果：演练模式 assistant 回复按段朗读，不重复、不丢段；手动点击「朗读」可重播；辅助模式不发任何声音；切换模式/停止/新 run 时播放立即中止；TTS 失败时文字回复仍完整可见且错误可见。
- 自动化验证：朗读事件带 `messageId + sequence` 且按该组合去重（覆盖 snapshot 重放与流式 delta）；`packages/tts` 两个协议 adapter 用 mock fetch 覆盖鉴权、hex 与二进制响应、`base_resp.status_code` 非 0、空音频与非音频响应；增量切句与整段切句结果一致，跨 delta 的 Markdown 不读出符号；`sentence-pipeline` 按 `sequence` 产出且单 delta 输入可退化；播放状态机覆盖取消、超时、失败回退；设置读写覆盖单一 provider、旧列表迁移与 keychain 隔离。
- 需要的实机验证：Windows 桌面端用用户自己的 TTS Key 与真实端点，记录中文音色、首字延迟（300 字回复目标 < 2s）、无重复朗读、切换模式打断、provider 侧用量展示；并验证 keychain 不可用时 fail-closed（不回退明文、不泄漏到日志）。未完成前不得把本 Note 迁到 `implemented/`。

## 风险

- 用户自有 Key 按字符/百万 tokens 直接对 provider 计费，单位随模型变化；Answra 不经手账单，需在 UI 记录 `usage`，避免用户在 provider 侧成本失控。
- BYO Key 把端点和 Key 的配置负担转给用户；端点填错或 Key 过期时必须有可观测的失败提示，并 fail-open 到纯文字回复，不能阻塞演练。
- 端点兼容性与响应格式随模型变化（DashScope 原生 / OpenAI 兼容 / MiniMax hex），必须逐个实测并把结论写进 adapter 测试；禁止凭「OpenAI 兼容」假设。
- 音频字节经 IPC 传递（Base64/hex 膨胀）需有界，避免大段文本合成撑爆帧；单帧设上限，超限由策略切段。
- 分段播放靠 `ended` 接力，段间可能有几十毫秒静音；自动朗读需实机确认可接受，手动朗读走 `whole-text` 规避。
- 增量文本存在未闭合 Markdown/代码块，净化必须有缓冲与超长兜底，否则会把符号读出来。
- 逐帧 delta 会增加 worker → main 消息量，需确认不重复发送正文。
- 自动朗读可能打扰用户：没有总开关，靠「未配置 provider 即不发声」与打断能力控制；失败时 fail-open（保留文字回复），不能因合成失败阻塞对话。
- 播放状态只在 UI，若与 assistant 消息投影不同步会出现「文字已滚动但声音仍在读旧消息」；按 `messageId` 绑定是唯一事实来源。
