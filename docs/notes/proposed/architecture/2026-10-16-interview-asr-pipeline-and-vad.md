# Note：面试语音识别管线与客户端 VAD 选型

状态：提案

## 问题

[面试模式持续监听与回答建议](../feature/2026-10-12-live-interview-assistant.md)已定为云端 ASR，但当前可访问的自部署 Qwen 服务只提供完整音频 HTTP `/transcribe`；其 WebSocket 路径在运行实例上返回 404。为了先验证音频采集、内部转录事件和回答触发，首轮采用该 HTTP 服务做 VAD 分段批式识别。它能按短块更新转录与临时建议，但每块要等完整 HTTP 识别，不能称作模型实时流式。DashScope realtime WS 和 AnswraSite AVP 网关留作后续路径，不作为本轮前置条件。

## 涉及范围

- 代码/模块：`packages/shared/src/channels.ts`（既有面试音频 IPC 类型）、`apps/agent` 面试转录 runtime 与 provider adapter、`apps/desktop` 音频采集/帧转发/STT 凭证、`packages/ui` 会话状态。STT 凭证与 Chat LLM 凭证分离。
- 进程/隐私表面：音频帧仍按总提案经 typed IPC 上行；Agent 经出站 HTTP 向内网 Qwen ASR 服务提交 WAV 分段；不在 Electron 中新增本地监听服务；音频和转录只在内存/请求期间存在，不落盘。
- 相关 Note：[面试模式持续监听与回答建议](../feature/2026-10-12-live-interview-assistant.md)、[Answra 实时语音识别私有协议（AVP）v1](2026-10-16-answra-voice-protocol-avp-v1.md)、[功能边界与本地运行时分层](../../implemented/architecture/2026-10-11-feature-boundaries-and-local-runtime.md)。

## 提案

### 模型选型规则与结论

按"计价单位跟随被计量模态"判断：Audio→Text 是 ASR（按音频秒计费）；Text→Audio 是 TTS（按字符计费）；双向实时对话（Omni/Realtime conversation）按 token 计费且音频 token 单价远高于文本 token。面试场景只需「听 + 文字建议」，因此**只使用 ASR + 既有文本 LLM，明确排除 TTS 与 Omni 对话模型**。

- **首轮验证：内网自部署 `Qwen3-ASR-0.6B`（HTTP 批式）**。当前实例 `http://10.76.13.161:10017` 的 `/health` 返回 `ready`/`cuda`，`POST /transcribe` 接收 multipart 字段 `file`、`language`，返回 `text`、`language`、`elapsed_seconds`、`model`；服务端限制音频文件 20 MiB、解码时长 60 秒、排队满时返回 503 和 `Retry-After`。运行实例的 `/ws/asr` 返回 404，因此本轮不能依赖下载目录中的 WS 草稿，也不要求先替换远端服务。Agent adapter 将采集 PCM 编成 16 kHz mono PCM WAV 后提交。该服务不按外部 API 秒/token 计费，但 GPU 排队与推理延迟仍需测量。
- **后续 realtime 候选：DashScope Recognition WS / `qwen3-asr-flash-realtime`**。这些是不同模型与不同上游协议；只有在确实需要模型级实时 partial、且当前 HTTP 分段延迟不达标后再评估。它们不属于当前首轮实现。
- **后续云端批式候选：`qwen3-asr-flash` / Mimo `mimo-v2.5-asr`**。按供应商要求封装 WAV/Base64 并提交完整分段；SSE 响应只表示响应传输分块，不表示音频实时上行。它们不是当前首轮验证依赖。
- **批式分段语义**：本地 VAD 持续收 PCM，保留可配置的句首 pre-roll 与句尾 hangover；静音断句时提交当前段。持续讲话超过段长上限时，在低能量位置切成连续 chunk 并继续采集。ASR 返回的 chunk final 与说话轮次结束是两个不同事实：只有 VAD 确认 utterance 结束的结果能触发回答判断；强切 chunk 只追加转录上下文，不能单独触发回答。每个结果携带 `source`、`utteranceId`、`chunkIndex`、音频起止时间和 `boundaryKind`（`utterance-end` / `continuation`），使异步响应按音频顺序合并并阻止旧结果触发新问题。
- **provider 音频能力**：不能假设所有 HTTP ASR 接受采集得到的 PCM。Mimo 当前 Speech Recognition 文档的 `mimo-v2.5-asr` 只列出 WAV/MP3、Base64 输入和 10 MB 限制；接入时需在 adapter 内把 16 kHz mono PCM chunk 封装为带正确 RIFF/WAV 头的 WAV data URL，并按 Base64 膨胀后的请求大小限制段长。provider 配置需声明输入格式、请求大小/时长限制、语言参数、partial/final 语义与是否支持流式音频输入；OpenAI-compatible 不能作为 realtime 能力标记。
- **两路音频复用同两套模型**：面试官（系统 loopback）与候选人（麦克风）各一条独立连接/请求，segment 带 source 标记，由总提案规定的「系统发言触发判断、麦克风仅作上下文」消费。

### VAD 责任边界（当前批式切段与未来 realtime 门控）

当前 Qwen HTTP 批式路径中，本地 VAD 是切段正确性前提：需要句首 pre-roll、防止截掉起始辅音；使用 hangover/静音阈值闭合自然语句；短静音不能过早拆分；连续讲话须在 provider 限制前强切到低能量位置并标记 continuation；停会话时 flush 尾段并等待/取消在途请求。VAD 推理失败不能假装静音或静默丢音，应明确报错并停止批式会话。未来接入 realtime provider 后，服务端 VAD 可负责断句；客户端 VAD 若启用，只作静音发送门控以控制成本，失败时 fail-open，不能丢音。

Qwen HTTP 模式由客户端 VAD 持续接收 PCM，并按短暂停顿或最大块长形成完整 WAV 分段；上传与后续采集并行，每段单独请求 `/transcribe`。首轮参数以可配置的短块为目标（约 2.5–6 秒作为待测区间，不是服务承诺），短静音触发自然分段，连续讲话在低能量点强切。每个请求返回前没有 ASR 文本，不能伪造 `transcript.delta`；响应到达后发 chunk-final，按音频序号合并。请求串行或低并发、有界排队；过载/超时须明确显示 transcript gap，不能无提示丢掉最终段。该模式避免等待整场结束，但用户感知延迟至少包含切段、完整 HTTP 推理和 LLM 首段生成。

批式队列必须有界并定义溢出行为，按音频时间戳/序号合并乱序结果；限流重试不能无限积压。每段上传使用可取消请求和会话代次，停止/切换 provider 后迟到响应不得进入 transcript 或触发回答。自动故障降级前须确认目标批式 provider 已配置并获授权；状态对 UI 可见。进入批式后本轮会话保持该模式，除非明确实现并测试回切策略，避免 WS/HTTP 来回切换和重复识别。

### 新问题打断与回答触发

- 面试官系统音频与候选人麦克风始终继续采集；取消回答生成不能停止转录会话。
- 系统音频检测到可信的新发言起点后，立即使当前回答 run 过期并 abort LLM 请求。需要通过 VAD onset 连续帧/迟滞抑制点击声和短噪声，不能把单个能量尖峰当打断；起点判定阈值由真实音频评估确定。
- 新发言的 partial transcript 可用于显示和取消旧答案。realtime partial 可按产品策略触发可撤销的预览；批式 chunk final 到达后可启动/更新带 generation id 的临时建议，不必等整个长 utterance 完成。新 chunk 到达时旧临时 run 立即过期；确认 utterance end 后，合并有序 chunk，经过短暂可配置的 turn-settle 窗口合并紧邻续句，再以完整转录启动最终建议。最终边界以系统音频为准；麦克风最终转录只作为候选人上下文，不触发回答。
- 如果新发言在回答判断或生成期间继续到达，旧 run 立即失效；新的最终 utterance 成为唯一可触发输入。旧请求即使不支持真正取消、稍后返回，也必须因 generation/session id 不匹配而被丢弃，不能覆盖新答案。
- 批式 ASR 在短暂停顿和最大 chunk 时都可提交；自然 utterance end 的末段完成后才标记完整轮次。continuation chunk 可以触发明确标注的临时建议，但不能标记为完整答案；后续 chunk 必须能撤销旧 run、更新上下文并替换临时建议。只有所有属于该轮的 chunk 按序完成后才可提交最终建议。等待设置有界超时，超时应显示识别不完整/失败而不是把缺失内容当作完整问题。
- UI 将被打断的回答标记为已过期/被新问题取代，不把旧回答与新答案拼成一个连续答案；捕获、ASR 或新问题失败时展示状态并继续监听，不因 LLM 取消而重启音频链路。

该策略是有意的 barge-in：**面试官重新说话时取消旧回答，但持续听；新一轮转录完成后用更新后的上下文重新回答。**排队等待旧答案完成会把过期答案展示给用户；让模型在同一个请求里直接“续聊”则缺少稳定的撤销/上下文边界，因此首版每个有效 interviewer turn 使用独立、可取消且有 generation id 的判断/生成 run。

### 凭证与传输形态（中转直连首发 / 网关透传后切）

- **首轮路径：Agent 直连内网 Qwen HTTP**。独立于 Chat LLM 的模型设置，使用可配置的 ASR endpoint；不伪装成 OpenAI API，也不增加 desktop 本地代理。当前部署无鉴权且为内网 HTTP，仅作开发/内测；不得把地址或无鉴权方式当作面向公网/普通用户的产品配置。
- **后续产品化：AnswraSite AVP 网关**。网关端点上线后再按 AVP 接入并处理凭证、路由、授权和用量；不能把当前内网地址硬编码进发布包。

当前只定义 Agent 内部的 `TranscriptionProvider` 契约，不实现网络 AVP：adapter 将会话开/停和音频输入映射为 provider-neutral transcript 事件，事件含 `source`、`utteranceId`、`chunkIndex`、音频起止时间、`isFinal` 与 `utteranceEnded`。首个 HTTP adapter 管理有界请求队列、取消和迟到响应；未来 realtime adapter 再补充连接重试与断线状态。只有需要跨进程网关传输时，才评审并冻结 [AVP 网络协议](2026-10-16-answra-voice-protocol-avp-v1.md)。

## 模块边界

- `packages/shared`：只承载既有面试会话/转录/建议类型与 typed IPC contract，不知道任何 DashScope 事件细节；VAD 门控开关是其状态字段。
- `apps/agent`：runtime utility worker 拥有 provider-neutral `TranscriptionProvider`、Qwen HTTP adapter、VAD 分段调度、转录聚合与触发判断；不依赖 Electron API。AVP 的网络服务端仍属未来网关工作。
- `apps/desktop` main：音频采集（Electron loopback + getUserMedia）、音频帧转发、STT 凭证 safeStorage 读写、run/socket 生命周期回收；不解析转录语义。
- `packages/ui`：仅展示会话/断句/用量与错误状态，不持 key、不做采集。
- AnswraSite 网关：本轮不参与语音；AVP 服务端、短期凭证和商业用量计量为后续独立工作。

## 曾考虑的替代方案

- **腾讯云实时语音识别（总提案原首选）**：一句一句断句能力强，但接入面更重——需额外 AppID/SecretKey 签名体系且以本地回调/密钥中心形态接入为常见路径；DashScope 提供官方 realtime WS 协议样例与 OpenAI 兼容批式两条路径，BYOK 接入成本更低。保留为后续 provider adapter 候选，不弃用其可用性。
- **AnswraSite 网关语音专用端点（/v1/realtime、/v1/live、/v1/stt）**：真实接入现状是全部分平台/未接入——`/v1/realtime` 仅 Grok 分组（`handler/grok_audio.go` 平台硬校验）、`/v1/live` 需 macOS attestation 且 Windows 503、`/v1/stt` 为 xAI 直通 `buildGrokVoiceURL`。接入须改网关代码，故 STT 不走这些端点；但网关**通用** `/v1/chat/completions` raw 转发不动 content 块与未知顶层字段，可承载批式 ASR（用户网关侧已验证，实施时需以真实请求复测）。
- **把批式 ASR 当作实时流式的等价替代**：本地 VAD 可以按句/按短 chunk 上传，改善整场录音结束后才识别的体验；但每段仍要等待 VAD 闭合或达到强切上限、完整请求处理和网络往返，没有实时 partial。仅在产品接受该延迟、UI 清楚显示批式状态且端到端测试达标时使用；否则作为明确降级，不能对外承诺 realtime。
- **不带 VAD 地每隔固定时间上传**：实现直观，但会频繁切断单词/句子、重复计费，并在 chunk 边界损失上下文；舍弃。连续语音强切只作为保护上限，并在静音低能量处切分、保留少量边界重叠后去重。
- **借道网关语音专用端点接入 realtime（`/v1/realtime` 仅 Grok 分组）**：唯一可行性是 platform=grok 账号 + base_url 指向 DashScope WS 的语义错位 hack（白名单/请求头都要绕，网关还按 token 给 ASR 计费），工程债大于收益；正确形态是网关建 AVP 透传（见 AVP Note）。
- **Qwen-Omni-Realtime 对话模型**：能听能说但按 token 计费且音频 token 单价高一个量级；面试不需要"AI 说话"，成本数倍、交互形态不符。明确排除。
- **非 VAD 模式（realtime turn_detection 为手动 commit）**：官方样例注明需客户端控制在 60 秒内发送并手动 `input_audio_buffer.commit`，额外状态机复杂；主路径默认 `server_vad`。
- **关闭客户端发送门控（realtime 门控）**：门控失效时仍须 fail-open 全量发送保底，绝不静音丢声；静默期全量发送只是多计费，不是丢内容风险，故门控是成本优化而非正确性前提，同样不做用户可见开关、只保留内部降级路径。批式降级中的 VAD 切段才是正确性前提（见上）。
- 本地 Whisper/Ollama、浏览器 SpeechRecognition、一次性音频上传已在总提案替代方案中否决，本 Note 不重复。

## 风险

正面权衡：复用当前已运行的内网 Qwen 服务，不增加模型 API 费用、不依赖新的云端凭证或远端部署改造，可先验证采集、分段、内部协议映射和回答触发。代价是请求级批式识别延迟，无法得到模型原生 partial，也不能作为普通用户产品路径。

风险与约束：当前内网 HTTP 无鉴权且无 TLS，音频仅可发往受控内网；超时/503、GPU 排队、VAD 误切和低能量强切均可能造成延迟或 transcript gap。必须明确 chunk-final 与 utterance-ended，限制缓存与队列，不记录音频/转录，并按真实面试样本测端到端 P50/P95。当前路径只用于开发验证；实时 WebSocket 能力和产品用户可用的托管 endpoint 尚未实现。

## 验收标准

- Qwen HTTP adapter mock 测试：WAV 编码/采样率、multipart 字段、语言值和 JSON 响应映射、超时/503/`Retry-After`、取消与迟到响应忽略。
- VAD 分段/调度测试：句首 pre-roll、短静音、最大时长低能量切分、持续采集期间 HTTP 请求、每 source 有界队列、乱序/重复/重叠结果合并和 overflow 状态。
- 触发语义测试：continuation chunk 可启动/更新临时建议但 UI 明确标记未完成；新 chunk 会过期旧临时 run；自然 utterance end 且所有 chunk 完成后可提交最终建议；旧 utterance/provider/session 的迟到结果不能覆盖新问题或启动回答。
- barge-in 测试：可信 interviewer speech-start 取消当前 LLM run 但不停止两路采集/ASR；噪声尖峰不取消；新 utterance end 后仅最新 generation 可启动/提交答案；候选人麦克风发言不触发回答。
- 端到端延迟与稳定性评估：按 provider 记录 interviewer speech-end→完整 transcript、speech-start→旧 run cancel、speech-end→新建议首个有用文本的 P50/P95；标注过早触发率、漏打断率、噪声误打断率、ASR 漏词/重叠去重错误。使用带标注的中英文面试样本覆盖思考停顿、短停顿续句、多人重叠、噪声和长问题；实时与批式分开报告，未达到产品阈值不得把批式描述成实时辅助。
- realtime/批式都输出相同 transcript 事件契约，但批式 provider 不伪造 partial 事件；能力元数据能让上层与 UI 知道当前模式和可用事件。
- VAD 测试：静音不上传、短语音和句首 pre-roll 保留、hangover 结束、连续语音强切边界、推理错误显式失败；realtime 发送门控故障则 fail-open。
- 配置测试：ASR endpoint/provider 与 Chat 模型凭证隔离；当前内网 endpoint 仅开发配置，不能打包为默认公网服务。
- 共享协议不含 DashScope/AVP 事件类型；key 永不出现在 renderer 可见表面；STT 凭证与 LLM 凭证分别为两个实体。AVP 协议相关验收见其 Note。
- 实机验证：用当前 Qwen `/transcribe` 跑 Windows 真实 loopback 音频，记录识别准确率、分段/句尾→首条临时建议 P50/P95、队列积压和 transcript gap；未完成不迁入 `implemented/`。

## 验证证据

- 官方文档（千问AI平台，user 提供链接与截图，`/docs/developer-guides/speech/asr-realtime`，2026-10-16 核对）：DashScope 原生 Recognition WS 协议最小实现（Python/Node/Java/C# 四语言示例），`wss://maas.qianwenaiapi.com/api-ws/v1/inference`（中转域）为官方示例 base 地址；`run-task`/`finish-task`/二进制帧上行、`task-started`/`result-generated`/`task-finished`/`task-failed` 事件、`payload.usage.duration`；`qwen-audio-3.0-asr-flash-streaming` 的 VAD 参数为 `max_sentence_silence`（ms），3.1 message 系列为 `vad_model`，Qwen3-ASR-Flash-Realtime 为 `session.turn_detection`；句级/字级时间戳结构样例；模型页（user 截图）标注"单工实时语音识别"、¥0.00033/秒、RPM 1K、免费额度 36K 秒。
- 旧证据（保留为备选 adapter 参考）：`qwen3-asr-flash-realtime`（OpenAI Realtime 事件风格，`/api-ws/v1/realtime`，`session.update` + `input_audio_buffer.append` 3200B/100ms，非 VAD 模式需 ≤60s 并 commit）。
- 千问AI平台文档（user 提供链接，`platform.qianwenai.com/docs/developer-guides/speech/speech-to-text-models`，2026-10-16 核对）：`qwen3-asr-flash` 列为"非实时 / HTTP（OpenAI 兼容）"，单段 5 分钟/10MB；非实时音频规格中 Qwen3-ASR-Flash 的输入方式为"URL / Base64 / 本地文件绝对路径"（仅 *filetrans* 系列为"公网可访问的文件 URL"）；`qwen3-asr-flash-realtime` 列为"实时 / WebSocket"。
- 阿里云文档：`qwen3-asr-flash` OpenAI 兼容响应含 `usage.seconds` 与 `prompt_tokens_details.audio_tokens`；快照退役公告 `2026-02-10`（退役日期 2026-10-10）；`-filetrans` 仅异步。
- Mimo 官方 ASR 文档（用户提供链接，2026-10-19 核对）：模型 `mimo-v2.5-asr` 使用 `/v1/chat/completions`，输入是完整 Base64 WAV/MP3 音频（限制 10 MB）；`stream:true` 说明响应以 SSE 返回，不代表音频分帧实时上行。故 Mimo 可评估为批式 adapter，不能归入 realtime 能力。
- 参考仓库 `D:\codespace\natively-cluely-ai-assistant` 的 `LICENSE` 将其标为 source-available、限个人/教育/研究/非商业用途，并限制未经书面许可将代码、架构或实现细节用于商业产品。故本提案不把该仓库作为可移植实现来源；Answra 的 provider、分块状态机和阈值须依据供应商公开协议、仓库自身协议边界及自有中英文音频评估独立设计。许可证条款是否适用于具体业务应由项目维护方确认，商业复用须先取得权利方书面许可。
- AnswraSite 源码（`D:\learn\xx\AnswraSite\gateway`）：`server/routes/gateway.go:296` 只在 Grok 分组挂 `/stt`；`handler/grok_audio.go:30` 与 `service/grok_audio.go:38-40` 要求 `PlatformGrok`；`service/openai_gateway_grok_chat_bridge.go:451` 拒绝 `input_audio`（仅 Grok 桥；通用 chat raw 路径不触碰 content 块——user 网关侧验证，待实测复核）；`service/billing_service.go` 音频单价按小时/分钟/百万字符三种模式，未覆盖 token 型 ASR 请求。
- 2026-10-19 在线核对：`GET http://10.76.13.161:10017/health` 返回 `Qwen3-ASR-0.6B`、`status=ready`、`device=cuda`；OpenAPI 仅含 `/health` 与 `/transcribe`，`GET /ws/asr` 返回 404。说明当前可验证路径是 HTTP 批式，下载目录中的 WS 服务代码尚未运行在该 endpoint。
- 提案阶段无 Answra adapter、VAD 调度或真实面试音频评估；当前证据只证明内网 Qwen HTTP 服务可达，不证明识别质量/实时可用性。

