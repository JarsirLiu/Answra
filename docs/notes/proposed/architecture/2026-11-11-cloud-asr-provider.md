# Note：云端 ASR provider 接入与本地/云端显式切换

状态：提案

## 问题

当前面试转录只有本地内置 `paraformer-zh-small int8`：`LocalParaformerAdapter` 对 VAD 切出的 `AudioSegment` 整段同步解码，`recognizer` 由 desktop 组合根注入，`TranscriptionPump` 与 `InterviewRuntime` 都直接绑定这个具体类型。真实面试/会议音频的识别准确率不足，但“不准”可能来自 VAD 强切、pre-roll/hangover、loopback/麦克风质量、语言与口音，未必都是模型问题。

产品方向已把云端订阅列为终态主线（[面试语音识别管线与客户端 VAD 选型](2026-10-16-interview-asr-pipeline-and-vad.md)、[本地内置 ASR 路线](2026-10-21-local-asr-paraformer-small.md)），但当前代码没有可选的云端 provider，也没有 provider 选择、凭据、超时与错误路径。同时，[面试转录宿主接线](../../implemented/feature/2026-10-21-interview-transcription-host-wiring.md) 明确记录过“泵先消费具体 adapter，流式 provider 出现时再演进”；现在第二种 provider 即将出现，需要回访该决定，但不能把 VAD、turn assembler 或 reply 一起改掉。

## 涉及范围

- 代码/模块：`apps/agent/src/interview/transcription/`（provider 端口、云端 adapter、pump）、`apps/agent/src/interview/runtime.ts`、`apps/agent/src/host.ts`、`apps/agent/src/worker/protocol.ts`、`apps/desktop/src/main/conversation/workerTransport.ts` 与 `apps/desktop/src/main/conversation/worker.ts`、`apps/desktop/src/main/interview/`（配置与凭据注入）、`packages/shared/src/env.ts`（如需新增变量名）、`examples/vad-asr-eval/`。
- UI/进程/协议/持久化表面：云端模式下音频离开本机；desktop main 负责设置与凭据，agent 进程发起请求；访问令牌/API Key 不进 renderer、不写日志、不落明文盘；provider 选择是启动/会话级配置，不是 transcript 事件里的字段。
- 相关 Note：[面试语音识别管线与客户端 VAD 选型](2026-10-16-interview-asr-pipeline-and-vad.md)、[本地内置 ASR 路线与 Paraformer-zh-small int8 首选](2026-10-21-local-asr-paraformer-small.md)、[面试语音运行时模块边界与并行开发契约](2026-10-19-interview-runtime-module-boundaries.md)、[面试转录宿主接线](../../implemented/feature/2026-10-21-interview-transcription-host-wiring.md)、[桌面端云端模型调用契约](2026-10-18-desktop-cloud-model-call-contract.md)、[VAD + ASR 评测](../../implemented/process/2026-10-21-vad-asr-eval-harness.md)、[产品方向与 Agent 底座](2026-10-20-product-direction-and-agent-foundation.md)。

## 提案

### 决策 1：显式选择，不做静默 fallback

本地与云端是显式二选一，和 `ModelRouter` 对 Chat/Answer 的来源裁决保持同一种产品语义：选哪一路就只用哪一路。云端失败时上报明确的 `error` 事件（`unauthorized`、`timeout`、`provider-unavailable` 等），不自动改用本地模型，也不把本地失败偷偷上云。

理由：

- 同一段 interview 文本必须能回答“它是谁识别的”，否则准确率评测、计费、排障和用户信任都失去事实来源。
- 自动 fallback 会把网络故障、额度不足和模型质量混成一个“有时准有时不准”的黑盒，违反仓库对显式状态来源的要求。
- 10-21 Note 已明确本地路径是显式 provider 选型而非静默降级；本 Note 延续该边界。

默认值属于产品配置，不在本 Note 冻结：打包版可以默认云端并把本地作为离线/低配选项，开发态可以默认本地；无论默认值如何，切换必须是用户可见、可解释的。

### 决策 2：先做 segment provider，不先上 streaming

第一阶段新增 `CloudSegmentTranscriptionAdapter`，实现 `TranscriptionProvider` 的 segment 分支：

- 输入沿用现有 `AudioSegment`（16 kHz、mono、`pcm_s16le`、`boundary` 与音频时间范围）。
- 在 adapter 内封装 WAV（RIFF header + PCM data），按 provider 要求提交 multipart 或 JSON；不假设所有供应商接受裸 PCM。
- 输出只包含 `chunk-final` 与 `error`，不伪造 `partial`。UI 与产品文案不得把批式分段描述成实时流式。
- 保留 `sessionId`、`source`、`utteranceId`、`chunkIndex`、`startSample`、`endSample`、`boundary`，不新增 provider 专属字段。

streaming/WebSocket 留到实测延迟不达标后再评估。那时才需要让 pump 消费连续 PCM 帧、让 assembler 处理 `partial`；当前 `InterviewTurnAssembler` 会直接丢弃 `partial`，提前上流式只会多一套没有消费者的状态。

### 决策 3：把 pump/runtime 的 provider seam 打开

现有升级点集中在三处：

1. `TranscriptionPump.start(sessionId, provider)` 从 `LocalParaformerAdapter` 改为 segment provider 端口，可以用 `Extract<TranscriptionProvider, { inputMode: "segment" }>` 表达，避免 pump 承担尚未实现的 stream 分支。
2. `InterviewRuntime` 从 `recognizer: RecognizerSource` 改为 `TranscriptionProviderSource`：本地 source 包装现有 `RecognizerSource` 与 `LocalParaformerAdapter`；云端 source 用本次会话的配置和令牌构造 `CloudSegmentTranscriptionAdapter`。
3. `host.ts` 与 desktop worker 的注入参数改名/扩展，但 VAD、turn assembler、settler、reply loop 的契约不变。

这是对 10-21 宿主接线 Note 中“泵消费具体 adapter”的定向修订：当时只有一种 provider，直绑具体类型是合理的；现在第二种 provider 出现，seam 必须打开。仍然不引入完整 `TranscriptionProvider` union 分支，也不引入插件/DI 框架。

### 决策 4：配置与凭据

优先复用现有云端模型调用模式：

- 云端 ASR 走自家网关时，端点由云端能力配置下发，请求使用 desktop main 按会话注入的 access token；token 只存在于 main 与 agent 运行期请求头，不进 renderer、不落盘、不写日志（对齐 [桌面端云端模型调用契约](2026-10-18-desktop-cloud-model-call-contract.md)）。
- 如果后续支持第三方 BYO key，Key 由 desktop main 的 `safeStorage` 保管，按会话经 worker 消息注入；禁止 argv/env 传明文，禁止 renderer 读取。
- provider 选择与端点通过 worker 命令下发（例如扩展 `interview-start` 或新增 `configure-transcription`），不通过 renderer 任意 prompt 注入。
- 当前内网 Qwen HTTP 地址只能作为开发配置，不得硬编码进发布包；产品云端必须是可鉴权、可计费、可观测的网关端点。

### 决策 5：错误、超时与并发

- adapter 把 HTTP/网络失败归一化为现有 `TranscriptionErrorCode`：`unauthorized`、`timeout`、`provider-unavailable`、`provider-error`、`audio-too-long`、`invalid-audio`；错误信息不包含 token、完整 response body 或供应商内部地址。
- 单段请求必须有可配置超时并真正响应 `AbortSignal`；会话 stop/fail 后迟到响应不得产生事件。
- 仅对连接失败和 5xx 做有限次数的退避重试（例如一次），仍失败则上报 `retryable` error；不做无限重试，也不因为重试而重复投递同一 `chunkIndex` 的文本。
- 首版沿用 pump 的每会话串行链，先测量队列高水位与 P95；只有实测证明串行是瓶颈时，才评估每会话有限并行。不得无界并发上传。
- 云端用量接入现有 audio credit/配额口径，不新增第二套计费来源。

### 决策 6：先评测再改默认，不同时改 VAD

用 `examples/vad-asr-eval/` 在同一批 VAD 分段上比较本地与云端：

- 指标：CER（仅诊断）、逐段解码 P50/P95、`speech-end → chunk-final` 延迟、`turn-ready` 延迟、失败率、每分钟成本。
- 评测必须记录 provider、模型 ID/版本、端点环境、样本集与日期；同一段音频分别走两个 adapter，避免把 VAD 切分差异算到模型头上。
- 若本地与云端 CER 接近，优先检查 VAD 强切、重叠去重、麦克风/loopback 质量，而不是继续换模型。
- 未完成评测前不把云端设为唯一默认，也不对外宣称“更准”。

### 实施顺序

1. 用现有评测 harness 建立本地基线，选取 2–3 个候选云端 provider，确认协议、语言支持、分段限制、价格与隐私条款。
2. 解耦 seam：pump 消费 segment provider 端口，runtime 消费 provider source；本地模式行为与全部现有测试保持不变。
3. 实现 `CloudSegmentTranscriptionAdapter`，用假 HTTP server 做 contract tests（WAV、鉴权、超时、取消、错误映射、迟到丢弃）。
4. 接入配置与凭据注入、显式选择 UI/状态标识；云端未配置时保持本地可用。
5. 跑同段评测，记录证据，再决定默认值与是否进入 streaming 阶段。
6. 若进入 streaming，另行提案/更新 Note，不在本 Note 中预设 partial 语义与 turn 行为。

## 模块边界

- `packages/shared`：只放 desktop↔renderer 需要的 provider 选择/状态 DTO 与环境变量名；不出现供应商 wire 类型、模型文件名或云端 ASR 事件结构。
- `apps/agent/src/interview/transcription/`：provider 端口与本地/云端 adapter；不导入 Electron、UI 或 reply；adapter 不触发回答。
- `apps/agent/src/interview/runtime.ts`：唯一组合点，只装配 provider source、pump、VAD、assembler、settler；不出现供应商分支或算法。
- `apps/agent/src/host.ts` / `worker/protocol.ts`：接收 desktop 注入的配置与令牌；协议只放跨进程 DTO，不放供应商 SDK 类型。
- `apps/desktop/src/main/`：设置、`safeStorage`、token 供给、worker 启动与配置注入；不做 ASR 请求、不解析转录语义。
- `packages/ui`：只显示识别方式、云端/本地状态与服务端错误；不接触密钥，不决定 provider 行为。
- `examples/vad-asr-eval/`：独立评测 workspace，可引用生产 adapter，但生产代码不反向依赖评测脚本。

## 曾考虑的替代方案

- **自动 fallback（本地失败/低置信度自动上云，或云端失败自动回本地）：** 舍弃。当前本地 adapter 没有可信的置信度信号，低置信度无法可靠判定；静默切换会让同一段文本的来源不可追溯，并与现有模型来源“显式二选一”的产品语义冲突。若未来要做降级，必须把 provider 身份作为独立状态显式展示并单独提案。
- **让 pump 直接消费完整 `TranscriptionProvider` union：** 部分采纳。现在只有 segment 实现，直接接 union 会让 pump 承担未使用的 stream 分支；本 Note 用 segment-only 类型收窄，等 streaming adapter 真正落地再扩展。
- **首版直接上 streaming/WebSocket：** 舍弃。需要 provider 连接生命周期、重连、partial 合并、assembler 更新语义和 UI 预览策略，当前 assembler 还会丢弃 partial；先做 segment 能最快验证云端准确率与成本，延迟不达标再升级。
- **把云端 ASR 放在 desktop main 代理：** 舍弃。转录是 interview 领域逻辑，应留在 agent；desktop 只应持有采集、设置与凭据。反向代理还会引入一条新的 RPC 通道，扩大进程边界与测试面。
- **只升级本地模型（SenseVoice、paraformer-large、Whisper）：** 保留为并行评估项，但不作为唯一路径。10-21 实测中 large 并未稳定优于 small，安装包体积与 CPU 性能差异也更大；本地模型仍有离线价值，但不能替代云端质量上限。
- **复用 10-16 的内网 Qwen HTTP 服务作为产品云端：** 舍弃。该服务无鉴权、无 TLS、地址不可控，只适用于受控开发验证；产品云端必须走可鉴权、可计费的网关，不能把内网地址打进发布包。
- **整场录音结束后一次上传：** 舍弃。与现有 VAD 分段、turn settle 和 barge-in 语义冲突，长音频限制和隐私风险也更大；继续以 VAD segment 为上传单位。
- **不区分 source，统一上传两路音频：** 舍弃。上传范围必须按 `interviewer`/`candidate` 明确，不能因为 provider 统一就顺手把当前产品未使用的音轨也发到云端。

## 验收标准

- 可观察结果：用户能在设置中显式选择本地或云端识别；当前会话使用哪种 provider 可见；云端失败时显示明确错误并停止该段转录，不静默改用本地；切换 provider 需要新会话，不能在同一 `sessionId` 内混用。
- 自动化验证：本地模式全部现有测试通过；云端 adapter contract tests 覆盖 WAV 头/采样率/声道、multipart 或 JSON 字段、Bearer 鉴权、超时/取消、401/413/429/5xx 映射、迟到响应丢弃、同段重试不重复投递；pump/runtime 测试证明 provider 可替换且 VAD/turn 行为不变；日志断言不含 token/API Key。
- 评测验证：同一批 VAD segment 上输出本地与云端的 CER、解码 P50/P95、`speech-end → chunk-final`、`turn-ready`、失败率与成本；记录 provider/model/日期，证据可复现。
- 隐私验证：云端模式首次启用有明确告知；上传的 source 范围与产品决定一致；关闭云端后不再发出任何 ASR 网络请求。
- 需要的实机验证：至少一台 Windows 目标机用真实面试/会议音频跑本地与云端各一轮，记录识别质量、延迟、断网/额度不足表现；未完成不迁入 `implemented/`。

## 风险

- **准确率风险仍是最高项**：云端模型可能改善字面识别，但 VAD 强切、重叠去重、麦克风/loopback 质量造成的语义丢失不会自动消失；必须用同段评测区分模型与分段问题。
- **延迟风险**：每段一次网络往返，4.5 秒段加排队可能超过现有 `turn-ready` 预期；首版串行 pump 还会放大双 source 的排队。若 P95 不达标，需要 streaming 或有限并行，但那会扩大改动面。
- **成本与配额风险**：云端 ASR 按音频时长计费，长时间面试的成本可能高于文本模型；必须接入现有配额/credit 口径，并在 UI 上让用户理解消耗。
- **网络与可用性**：云端模式依赖网络，断网、限流、供应商故障都会造成 transcript gap；显式错误比静默降级更重要，但用户体验需要产品文案配合。
- **隐私与合规**：面试音频包含个人信息，云端模式会把音频传出本机；必须有告知、明确的 source 范围、供应商数据处理条款与保留策略，不能只在代码里加一个开关。
- **凭据风险**：access token 或 BYO key 一旦进入 renderer、argv、日志或明文磁盘，泄露面会显著扩大；实施时必须复用 main 的 `safeStorage`/token 供给路径并加测试。
- **供应商锁定与模型漂移**：端点、模型 ID、分段大小限制和错误码可能变化；需要固定模型版本、在 adapter 边界归一化，并保留本地 provider 作为可选路径。
- **双路径维护**：本地与云端 adapter 共用同一 contract tests，否则两条路径的错误/取消语义会分叉；任何新 provider 都必须先过同一组测试。
- **重试重复**：云端请求重试可能造成同一 `chunkIndex` 文本重复或乱序；adapter 必须保证每段最多投递一个最终事件，pump 仍需按会话代次丢弃迟到结果。

## 验证证据

- 2026-10-21 本地基线：`examples/vad-asr-eval/` 在 AISHELL-1 S0002 上测得 paraformer-zh-small int8 对话口径 CER 3.09%、最大解码约 85 ms；同批 SenseVoice CER 8.02%、最大解码 275 ms。该数据只证明该样本集上的本地基线，不代表真实面试分布。详见[本地 ASR 路线与 Paraformer-zh-small int8 首选](2026-10-21-local-asr-paraformer-small.md)与 [VAD/ASR 评测](../../implemented/process/2026-10-21-vad-asr-eval-harness.md)。
- 2026-10-21 端到端延迟基线：真实 TEN VAD + repo segmenter + paraformer int8 在 68 秒连续流上，VAD RTF 0.0158、24 段、最长段就绪约 861 ms；说明 VAD 不是瓶颈，整段解码与静默闭合窗是当前延迟大头。详见[VAD 轮次延迟评测](../../implemented/testing/2026-10-21-vad-turn-latency-evaluation.md)。
- 截至本提案，尚未实现云端 adapter，也没有同一批真实面试音频上的本地 vs 云端对比；上述数据只作为基线与评测口径，不作为“云端更准”的证据。
