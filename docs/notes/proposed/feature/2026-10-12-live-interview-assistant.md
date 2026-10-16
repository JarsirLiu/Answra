# Note：面试模式持续监听与回答建议

状态：提案

## 问题

面试模式的「AI 建议」目前只是禁用入口。用户需要让应用持续监听面试官的系统声音，实时转录并判断何时需要作答；生成回答建议后会话仍继续监听，以识别追问。单次音频上传或复用笔试聊天无法满足持续会话、说话方区分和自动触发要求。

## 涉及范围

- 代码/模块：`packages/shared` 会话协议、`packages/ui` 面试入口/状态/建议视图、`apps/desktop` Windows 音频采集与权限、`apps/app` 实时云端 STT 与自动回答 runtime。
- 进程/数据表面：renderer 获取系统 loopback 与麦克风；类型化 IPC 传输音频帧和状态；utility worker 管理云端 STT、转录上下文、回答判断和云端模型流。会话 transcript 仅驻留内存，不写入磁盘。
- 相关 Note：[面试模式 AI 建议占位流程](../../implemented/feature/2026-10-11-floating-bar-surfaces-and-workflow.md)、[功能边界与本地运行时分层](../../implemented/architecture/2026-10-11-feature-boundaries-and-local-runtime.md)、[后端拥有会话与内存仓储](../../implemented/architecture/2026-10-12-conversation-memory-store-port.md)、[面试语音识别管线与客户端 VAD 选型](../architecture/2026-10-16-interview-asr-pipeline-and-vad.md)。

## 提案

首版实现持续面试会话，而非会议录音上传：用户只在进入模式时点击一次「开始面试」并完成系统要求的音频授权；会话开始后直到用户停止或会议结束，全程自动采集、转录、判断和生成回答建议，不要求用户逐轮点击「AI 建议」、确认问题或触发生成。界面持续显示采集/转录/判断/生成状态。系统音频是识别面试官问题的主通道，麦克风仅提供候选人已回答内容作为上下文。每个最终转录片段进入短时上下文，系统通道的发言轮次自动触发判断；不需要回答时继续监听，需要回答时自动在 Answra 浮层展示文字建议。回答生成不停止音频采集；出现新的面试官发言时使旧判断/答案失效并重新判断。用户可显式停止会话，会议音频停止或会议结束时也应自动收尾。

Windows 首版保持 Electron `29.4.6`，使用 Electron display-media handler 的系统 loopback 音频能力；Renderer 停止并丢弃视频轨，只发送音频 PCM。普通 Windows 设备不运行本地 STT 或本地 LLM：持续转录走云端服务（首版 realtime 流式识别、服务端 VAD 断句，批式仅作禁 WS 降级），自动回答走云端模型。STT 凭证与模型凭证是两个能力和授权边界，不能因为当前模型配置是 OpenAI-compatible 就假定它提供 Realtime API，也不能假定 ChatGPT/Claude 消费者订阅能直接用于 API 调用。

云端供应商通过独立 adapter 接入；ASR 供应商/协议主路径、私有语音协议（AVP）与客户端 VAD 分工分别见 [面试语音识别管线与客户端 VAD 选型](../architecture/2026-10-16-interview-asr-pipeline-and-vad.md)（主路径 realtime `qwen3-asr-flash-realtime` 云端 `server_vad` 断句直连 DashScope，批式仅作禁 WS 降级；AnswraSite realtime 透传为产品化切换路径）与 [Answra 实时语音识别私有协议（AVP）v1](../architecture/2026-10-16-answra-voice-protocol-avp-v1.md)（客户端/网关双端冻结的中间协议，上游路由在 adapter/网关侧），后续可增加腾讯云等其他支持流式 PCM、稳定终态和明确商业授权的云 STT。STT 凭证可由用户 BYOK，或由 Answra 账户订阅服务端代持并签发短时会话凭证；两种授权不可混淆。用户要求面向普通 Windows 用户的云端体验，因此产品版目标采用 Answra 托管订阅路径，不能把本地 Whisper/Ollama 作为回退。当前仓库没有 Answra 账户/计费后端，托管订阅所需服务端是上线前置工作；在该后端建成前，功能只能在开发/内测配置云厂商凭证，不得宣称普通订阅用户可用。自动回答走独立的云端 LLM provider adapter；现有 OpenAI-compatible 配置可作为开发首发，产品托管订阅需要由 Answra 后端提供受控模型路由或短期凭证。消费者版 ChatGPT/Claude 订阅不视为 API 权限。

面试回答首版不包含仓库/文件读取工具、资料选择、索引或检索。对话运行时与 IPC 需保持可扩展，但不能预先扫描或读取工作区。后续若加入工具调用，应作为独立功能设计，另行定义工具权限、文件范围、用户确认、云端数据发送和审计规则。

面试消息和转录不得进入笔试 `ActiveExamConversationId` 或一次性截图消息；会话独立、有界、内存驻留。关闭应用/停止面试时关闭音频轨、WebSocket 和活动 LLM 请求。日志只记录长度、阶段和错误码，不记录音频、转录正文、API Key。

## 影响表面

- `packages/shared`：面试会话 start/stop、PCM 帧、状态/转录/建议事件纯类型及 typed IPC contract。
- `apps/desktop`：仅 Windows 的 Electron loopback capture handler；验证 IPC sender 和活动 session，管理 start/stop 与 utility worker 转发；preload 只做桥接。
- `apps/app`：云端 STT provider adapter、system/mic 两路事件、候选发言聚合、是否回答判断、云端模型生成、取消/过期处理和有界上下文；不依赖 Electron/React、不运行本地模型。
- `packages/ui`：面试会话生命周期交互、实时状态和回答建议展示；不负责音频 provider 或模型请求。

## 曾考虑的替代方案

- **将音频作为笔试 Chat 的附件发送：** 不支持常驻监听、VAD 结束事件或持续多轮追问，而且会污染一次性笔试会话，因此舍弃。
- **只采集系统音频：** 可触发面试官问题，但无法让追问回答利用候选人此前说过的内容；因此保留独立麦克风上下文通道，但麦克风语音不触发回答。
- **先用浏览器 SpeechRecognition 或定长音频批上传：** 提供商和延迟行为不可控，无法可靠识别连续发言边界；因此使用明确的实时云端转录会话。
- **让普通用户本机运行 Whisper/Ollama：** Windows 设备性能、安装体积、显存和启动可用性不可控，且用户明确要求云端订阅服务；因此它们不得成为运行前提或静默回退路径。
- **把消费者版 ChatGPT/Claude 订阅等同于 API 权限：** 消费者订阅和厂商 API 计费/授权是不同产品；现有配置仅表示 OpenAI-compatible API 凭证，不代表能读取用户网页订阅。Answra 若要提供开箱即用的订阅 STT，需自建账户授权、服务端凭证保护、额度计量和流式中继。
- **直接指定 OpenAI Realtime：** 当前 Answra 只接受通用 Chat `baseUrl/model/apiKey`，并未验证用户 endpoint 支持 Realtime transcription；故 STT 必须有独立、可验证的云端能力配置或 Answra 托管服务。
- **首版内置仓库/文件工具：** 读取范围、确认交互和云端传输边界尚未设计，直接加入会扩大本次功能与隐私面；因此留作独立后续功能，不扫描或读取文件。
- **升级 Electron：** 不解决捕获、转录和触发问题，并会触碰已验证的 Electron 29 隐身基线；因此保持 `29.4.6`。
- **要求用户逐轮点击生成或确认回答：** 会打断面试交流并违背持续监听模式；会话启动后自动判断并显示文字建议。
- **自动向会议播放 AI 语音：** 容易打断面试和造成误发；该提案只在 Answra 浮层自动显示回答建议，不自动发声。

## 风险

- 首版系统 loopback 依赖 Windows Electron capture API；其他平台必须提供独立采集 adapter 并完成真实会议软件验证后才能声明支持。
- 实时语音 provider 与普通 OpenAI-compatible Chat endpoint 是不同能力。云端 STT 未授权/未配置时必须显式报错并停止本次面试启动，不得回退本地模型、浏览器识别或一次性上传。Answra 托管订阅上线前必须交付账户/授权、短时凭证、额度和服务端中继；BYOK 只能作为明确标注的开发/可选路径，设置中须单独配置 STT provider 和 API 凭证。现有 LLM API Key 不能冒充 STT 凭证。
- 本次面试实现不得隐式读取工作区、简历或项目文件；任何文件读取、仓库遍历或工具调用均属于后续独立功能，须另行定义授权和数据发送策略。
- 日志不得记录音频、transcript 正文、模型密钥或敏感会话内容。新的面试官发言使旧问题与生成流失效；回答生成期间继续采集。
- Electron `getDisplayMedia` 需要用户手势；只允许受信任的主窗口发起，主进程选择屏幕源并返回 loopback，渲染器立即停止视频轨。不得保存或上传视频帧。
- 转录按会话保留有界上下文；未另行定义用户可见的会议纪要/历史保留与删除行为前，不得落盘。
- 云端 STT/LLM 会传输面试音频或 transcript，涉及面试双方隐私、服务商数据保留和跨境合规；上线前需要产品隐私说明、供应商协议与区域策略。
- 实时识别可能误转录、网络抖动或服务端断流；自动判断可能漏答或误触发。首版自动在浮层显示建议、不自动向会议发声，并提供可见状态、取消和停止控制。
- Electron 保持 `29.4.6`；任何运行时依赖升级都需满足 Electron Node ABI 并单独验证隐身。

## 验收标准

- Windows 用户从面试模式可开始/停止会话，系统音频持续采集并实时产生面试官转录；权限、空音频、连接失败均有显式 UI 状态。
- 麦克风转录标记为用户上下文，不能触发自动回答；系统音频最终发言可以触发 AI 判断。
- 开始会话后无需逐轮点击或确认；普通陈述/对他人的问题保持静默，面试官向用户提问时自动出现回答建议。
- 生成回答期间采集保持活动；后续发言能更新上下文并取消/过期旧答案。
- Stop、窗口销毁、worker 退出、socket 错误均释放音频资源、WS 和活动 run；笔试聊天 transcript 不被污染。
- 自动化测试覆盖协议/转录事件/触发门控/过期/资源关闭；Windows 实机使用目标输出设备和至少一种会议软件验证系统声音来源、实时性、停止和隐身不回退。未做实机验证时不得标记为已实施。
- 隐私/授权测试确认云端 STT 或 LLM 未授权时不采集、不发送；断网、额度耗尽和服务商拒绝均有明确错误并可停止；停止/窗口关闭后释放音轨、socket 和临时 transcript。
- 面试会话不会调用工作区读取 API，不扫描本地文件或仓库；后续工具调用功能需单独增加测试与 Note。
- 产品发布前完成托管订阅服务端：账户 entitlement、ASR 供应商密钥保管、STT WebSocket 中继、LLM 路由、用量/并发限制、短时会话令牌、超额拒绝和无敏感内容日志。无该服务端时只允许受控 BYOK 内测，不得对外表述为订阅已接入。

## 验证证据

- Electron `29.4.6` 类型定义声明 `session.setDisplayMediaRequestHandler` 可授权 `audio: "loopback"`，并明确 loopback 目前仅支持 Windows。
- Natively 源码检查确认其参考形态为双通道捕获、流式 STT、系统通道发言结束后判断，回答生成与会议采集生命周期分离。其 `NativelyProSTT` 将 PCM 发往 `wss://api.natively.software/v1/transcribe`；区域 relay 启用时先向 `/v1/stt/session` 以 Natively API Key 或 trial token 换短期 session token，再连区域 WebSocket，失败可回落到 Natively 自有云端 STT 入口。该路径体现“本机只采集，STT 云端处理”，不是要求用户本地运行 Whisper。
- Natively 的托管 STT 依赖 Natively Pro/试用凭证与 Natively 服务端额度/路由；本地源码可证实客户端协议与凭证形态，不能单靠客户端源码核实生产后端最终选用哪家识别模型或完整订阅价格策略。
- Answra 当前 `apps/desktop/src/main/conversation/appService.ts` 仅安全存储通用 Chat `baseUrl/model/apiKey`，`apps/app/src/conversationRuntime.ts` 使用 OpenAI-compatible provider 做回答生成；仓库尚无账户订阅授权或 STT 云端中继。因此本 Note 是待评审方案，不宣称订阅模型接入已实现。
- Answra 当前 `WorkspaceService` 可在选定 root 内枚举/读取文件，工作区预览支持文本、PDF、DOCX 等；面试首版不接入这些 API。若未来增加文件工具，应另行复用并收紧工作区 root/path 边界，不得引入任意路径读取 IPC。
- 提案阶段尚无实现或运行时验证。
