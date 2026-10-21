# Note：面试模式持续监听与回答建议

状态：提案

## 问题

面试模式的「AI 建议」目前只是禁用入口。用户需要让应用持续监听面试官的系统声音，实时转录并判断何时需要作答；生成回答建议后会话仍继续监听，以识别追问。单次音频上传或复用笔试聊天无法满足持续会话、说话方区分和自动触发要求。

## 涉及范围

- 代码/模块：`packages/shared` 会话协议、`packages/ui` 面试入口/状态/建议视图、`apps/desktop` Windows 音频采集与权限、`apps/agent` 云端 STT 与自动回答 runtime。
- 进程/数据表面：renderer 获取系统 loopback 与麦克风；类型化 IPC 传输音频帧和状态；utility worker 管理云端 STT、转录上下文、回答判断和云端模型流。会话 transcript 仅驻留内存，不写入磁盘。
- 相关 Note：[面试模式 AI 建议占位流程](../../implemented/feature/2026-10-11-floating-bar-surfaces-and-workflow.md)、[功能边界与本地运行时分层](../../implemented/architecture/2026-10-11-feature-boundaries-and-local-runtime.md)、[后端拥有会话与内存仓储](../../implemented/architecture/2026-10-12-conversation-memory-store-port.md)、[面试语音识别管线与客户端 VAD 选型](../architecture/2026-10-16-interview-asr-pipeline-and-vad.md)、[面试语音运行时模块边界与并行开发契约](../architecture/2026-10-19-interview-runtime-module-boundaries.md)。

## 提案

首版实现持续面试会话，而非会议录音上传：用户只在进入模式时点击一次「开始面试」并完成系统要求的音频授权；会话开始后直到用户停止或会议结束，全程自动采集、转录、判断和生成回答建议，不要求用户逐轮点击「AI 建议」、确认问题或触发生成。界面持续显示采集/转录/判断/生成状态。系统音频是识别面试官问题的主通道，麦克风仅提供候选人已回答内容作为上下文。每个最终转录片段进入短时上下文，系统通道的发言轮次自动触发判断；不需要回答时继续监听，需要回答时自动在 Answra 浮层展示文字建议。回答生成不停止音频采集；出现新的面试官发言时使旧判断/答案失效并重新判断。用户可显式停止会话，会议音频停止或会议结束时也应自动收尾。

Windows 首轮保持 Electron `29.4.6`，使用 Electron display-media handler 的系统 loopback 音频能力；Renderer 停止并丢弃视频轨，只发送音频 PCM。ASR 先使用当前已运行的内网 Qwen3-ASR-0.6B HTTP `/transcribe`，由客户端 VAD 切成短 WAV 分段并异步识别；这是低成本技术验证路径，UI 需标为分段识别/较高延迟，不能称为模型 realtime。当前服务的 WebSocket 路径未部署，不作为首轮前提。后续可替换为 realtime WS provider 或 Answra 托管路径。自动回答走独立文本模型。STT endpoint 与模型凭证是两个能力和授权边界，不能因 Chat 模型是 OpenAI-compatible 就假定语音调用也兼容，也不能假定消费者订阅可直接用于 API 调用。

ASR provider 通过独立 adapter 接入。首轮连接当前内网 Qwen HTTP 服务；adapter 把完整分段请求映射成统一转录事件，chunk final 不等于面试官 turn final。分段策略与 provider 能力见 [面试语音识别管线与客户端 VAD 选型](../architecture/2026-10-16-interview-asr-pipeline-and-vad.md)；provider-neutral 事件和未来网关 wire 见 [Answra 实时语音识别私有协议（AVP）v1](../architecture/2026-10-16-answra-voice-protocol-avp-v1.md)。当前内网 endpoint 只用于受控开发验证，不硬编码进发布包。后续可增加实时 WS adapter 和 Answra 托管订阅路径；产品上线需要账户授权、凭证保护、用量限制和服务端路由。当前不以本地 Whisper/Ollama 作为设备上的静默回退。自动回答走独立文本模型 provider；云端订阅和消费者版 ChatGPT/Claude 订阅都不自动授予 ASR/LLM API 权限。

> 2026-10-21 边界修订（不改写上文原句）："不以本地 Whisper/Ollama 作为静默回退"仍然成立。变化的是产品方向增加了**随安装包分发的轻量内置模型**这一档位（sherpa-onnx paraformer-zh-small int8，约 82MB，非 Whisper/Ollama 路线），它是显式 provider 选型而非静默降级，且云端订阅 ASR 仍是终态主线。依据与实施顺序见 [本地内置 ASR 路线与 Paraformer-zh-small int8 首选](../architecture/2026-10-21-local-asr-paraformer-small.md) 及其阶段记录（adapter、资源准备与 utility process 加载验证）。本修订只放宽"本地模型"这一对象，不放宽"不得静默回退、不得成为运行前提"这两条约束。

面试回答首版不包含仓库/文件读取工具、资料选择、索引或检索。对话运行时与 IPC 需保持可扩展，但不能预先扫描或读取工作区。后续若加入工具调用，应作为独立功能设计，另行定义工具权限、文件范围、用户确认、云端数据发送和审计规则。

面试消息和转录不得进入笔试 `ActiveExamConversationId` 或一次性截图消息；会话独立、有界、内存驻留。关闭应用/停止面试时关闭音频轨、WebSocket 和活动 LLM 请求。日志只记录长度、阶段和错误码，不记录音频、转录正文、API Key。

## 影响表面

- `packages/shared`：面试会话 start/stop、PCM 帧、状态/转录/建议事件纯类型及 typed IPC contract。
- `apps/desktop`：仅 Windows 的 Electron loopback capture handler；验证 IPC sender 和活动 session，管理 start/stop 与 utility worker 转发；preload 只做桥接。
- `apps/agent`：Qwen HTTP ASR provider adapter、system/mic 两路 VAD 分段与事件聚合、是否回答判断、文本模型生成、取消/过期处理和有界上下文；不依赖 Electron/React，不开启本地网络 listener。
- `packages/ui`：面试会话生命周期交互、实时状态和回答建议展示；不负责音频 provider 或模型请求。

## 曾考虑的替代方案

- **将音频作为笔试 Chat 的附件发送：** 不支持常驻监听、VAD 结束事件或持续多轮追问，而且会污染一次性笔试会话，因此舍弃。
- **只采集系统音频：** 可触发面试官问题，但无法让追问回答利用候选人此前说过的内容；因此保留独立麦克风上下文通道，但麦克风语音不触发回答。
- **用固定时长切片上传代替 VAD 分段：** 可能在词中切断音频、无法确认发言结束，并把 chunk 完成误当成问题完成；因此批式模式也必须定义 VAD 断句和 continuation 语义，且标记为较高延迟模式。
- **先用浏览器 SpeechRecognition：** 提供商、权限和延迟行为不可控，无法作为稳定云端 provider；因此不纳入首发。
- **让普通用户本机运行 Whisper/Ollama：** Windows 设备性能、安装体积、显存和启动可用性不可控，且用户明确要求云端订阅服务；因此它们不得成为运行前提或静默回退路径。
  - 2026-10-21 修订：本条否决对象是"让用户本机跑 Whisper/Ollama 大模型"，对"随安装包分发的轻量内置模型"不适用（体积、启动可用性、许可与隐私面都不同，且该内置模型作为显式 provider 档位交付）。原否决结论保留有效，不因本修订失效。
- **把消费者版 ChatGPT/Claude 订阅等同于 API 权限：** 消费者订阅和厂商 API 计费/授权是不同产品；现有配置仅表示 OpenAI-compatible API 凭证，不代表能读取用户网页订阅。Answra 若要提供开箱即用的订阅 STT，需自建账户授权、服务端凭证保护、额度计量和流式中继。
- **直接指定 OpenAI Realtime：** 当前 Answra 只接受通用 Chat `baseUrl/model/apiKey`，并未验证用户 endpoint 支持 Realtime transcription；故 STT 必须有独立、可验证的云端能力配置或 Answra 托管服务。
- **首版内置仓库/文件工具：** 读取范围、确认交互和云端传输边界尚未设计，直接加入会扩大本次功能与隐私面；因此留作独立后续功能，不扫描或读取文件。
- **升级 Electron：** 不解决捕获、转录和触发问题，并会触碰已验证的 Electron 29 隐身基线；因此保持 `29.4.6`。
- **要求用户逐轮点击生成或确认回答：** 会打断面试交流并违背持续监听模式；会话启动后自动判断并显示文字建议。
- **自动向会议播放 AI 语音：** 容易打断面试和造成误发；该提案只在 Answra 浮层自动显示回答建议，不自动发声。

## 风险

- 首版系统 loopback 依赖 Windows Electron capture API；其他平台必须提供独立采集 adapter 并完成真实会议软件验证后才能声明支持。
- ASR provider 与普通 OpenAI-compatible Chat endpoint 是不同能力。当前开发路径只允许连受控内网 Qwen HTTP endpoint；endpoint 不可达时显示错误，不回退浏览器识别或静默上传整场音频。当前 Qwen 服务无鉴权且为 HTTP，不能暴露公网或用于普通发布版。产品上线前必须提供受控托管/授权路径；STT endpoint 与 Chat 模型凭证独立。
- 本次面试实现不得隐式读取工作区、简历或项目文件；任何文件读取、仓库遍历或工具调用均属于后续独立功能，须另行定义授权和数据发送策略。
- 日志不得记录音频、transcript 正文、模型密钥或敏感会话内容。新的面试官发言使旧问题与生成流失效；回答生成期间继续采集。
- Electron `getDisplayMedia` 需要用户手势；只允许受信任的主窗口发起，主进程选择屏幕源并返回 loopback，渲染器立即停止视频轨。不得保存或上传视频帧。
- 转录按会话保留有界上下文；未另行定义用户可见的会议纪要/历史保留与删除行为前，不得落盘。
- 内网 Qwen STT 会把面试音频分段传到部署主机，自动回答会把 transcript 传给所选文本模型；涉及面试双方隐私、内网访问控制和服务商数据处理，启用前需明确告知，发布前确定保留和区域策略。
- 实时识别可能误转录、网络抖动或服务端断流；自动判断可能漏答或误触发。首版自动在浮层显示建议、不自动向会议发声，并提供可见状态、取消和停止控制。
- Electron 保持 `29.4.6`；任何运行时依赖升级都需满足 Electron Node ABI 并单独验证隐身。

## 验收标准

- Windows 用户从面试模式可开始/停止会话，系统音频持续采集并按 VAD 片段提交内网 Qwen ASR；UI 明确标记分段识别状态，权限、空音频、HTTP 失败/队列拒绝均有显式状态。
- 麦克风转录标记为用户上下文，不能触发自动回答；系统音频最终发言可以触发 AI 判断。
- 开始会话后无需逐轮点击或确认；普通陈述/对他人的问题保持静默，面试官向用户提问时自动出现回答建议。
- 生成回答期间采集保持活动；后续发言能更新上下文并取消/过期旧答案。
- Stop、窗口销毁、worker 退出、socket 错误均释放音频资源、WS 和活动 run；笔试聊天 transcript 不被污染。
- 自动化测试覆盖 Qwen HTTP adapter、分段事件/触发门控/过期/资源关闭；Windows 实机使用目标输出设备和至少一种会议软件验证系统声音来源、分段延迟、停止和隐身不回退。未做实机验证时不得标记为已实施。
- 隐私/授权测试确认云端 STT 或 LLM 未授权时不采集、不发送；断网、额度耗尽和服务商拒绝均有明确错误并可停止；停止/窗口关闭后释放音轨、socket 和临时 transcript。
- 面试会话不会调用工作区读取 API，不扫描本地文件或仓库；后续工具调用功能需单独增加测试与 Note。
- 产品发布前完成托管服务端：账户 entitlement、ASR 路由/凭证保管、LLM 路由、用量/并发限制、短时会话令牌、超额拒绝和无敏感内容日志。开发阶段使用当前内网 Qwen endpoint，不要求更改其部署；该路径不得被描述为面向普通用户的订阅能力。

## 验证证据

- Electron `29.4.6` 类型定义声明 `session.setDisplayMediaRequestHandler` 可授权 `audio: "loopback"`，并明确 loopback 目前仅支持 Windows。
- 内网 Qwen endpoint（2026-10-19 核对）：`GET http://10.76.13.161:10017/health` 返回 `Qwen3-ASR-0.6B`、`ready`、`cuda`；OpenAPI 仅列 `/health` 与 `/transcribe`，`/ws/asr` 返回 404。首轮因此按 HTTP VAD 分段设计，不假定实时 WS 已部署。
- Natively 源码检查确认其参考形态为双通道捕获、流式 STT、系统通道发言结束后判断，回答生成与会议采集生命周期分离。其 `NativelyProSTT` 将 PCM 发往 `wss://api.natively.software/v1/transcribe`；区域 relay 启用时先向 `/v1/stt/session` 以 Natively API Key 或 trial token 换短期 session token，再连区域 WebSocket，失败可回落到 Natively 自有云端 STT 入口。该路径体现“本机只采集，STT 云端处理”，不是要求用户本地运行 Whisper。
- Natively 的托管 STT 依赖 Natively Pro/试用凭证与 Natively 服务端额度/路由；本地源码可证实客户端协议与凭证形态，不能单靠客户端源码核实生产后端最终选用哪家识别模型或完整订阅价格策略。
- Answra 当前通用 Chat 凭证由 desktop main 安全存储，Agent runtime 使用 OpenAI-compatible provider 做回答生成；仓库尚无账户订阅授权或 STT 云端中继。因此本 Note 是待评审方案，不宣称订阅模型接入已实现。
- Answra 当前 `WorkspaceService` 可在选定 root 内枚举/读取文件，工作区预览支持文本、PDF、DOCX 等；面试首版不接入这些 API。若未来增加文件工具，应另行复用并收紧工作区 root/path 边界，不得引入任意路径读取 IPC。
- 提案阶段尚无实现或运行时验证。
