# Note：面试语音运行时模块边界与并行开发契约

状态：提案

## 问题

面试模式需要持续采集两路音频、VAD 分段、ASR 转录、面试官轮次聚合、问题判断和可取消的回答生成。若把这些职责放进一个 runtime 或复用通用对话事件，任何一处改动都会波及其他团队：调 VAD 需要理解模型协议，换 ASR 需要修改回答逻辑，改回答生命周期又可能破坏音频监听。当前 `packages/shared/src/channels.ts` 已有面试 PCM 帧和展示事件，但它们尚未被运行时实现验证，不能直接视为内部领域模型或网络协议。

首轮必须复用当前可用的 Qwen3-ASR-0.6B HTTP `/transcribe` 服务，同时为以后 realtime provider 留下可扩展位置；模块边界需要先冻结，使多名开发者能按接口并行工作。

## 涉及范围

- 代码/模块：`apps/agent/src/interview/` 新领域目录；既有 `apps/agent/src/worker/protocol.ts`、`apps/desktop/src/main/` 音频采集和转发；`packages/shared/src/channels.ts` 面向 DesktopBridge 的 IPC 类型。
- 进程/协议表面：Windows 音频捕获留在 desktop；Agent 拥有 VAD、转录、turn 聚合和回答工作流。内部 TypeScript 契约不等于网络 AVP；当前不新增本地 listener 或 AVP wire client。
- 相关 Note：[面试语音识别管线与客户端 VAD 选型](2026-10-16-interview-asr-pipeline-and-vad.md)、[面试模式持续监听与回答建议](../feature/2026-10-12-live-interview-assistant.md)、[Answra 实时语音识别私有协议（AVP）v1](2026-10-16-answra-voice-protocol-avp-v1.md)、[Agent runtime 分层](../../implemented/architecture/2026-10-17-agent-runtime-rename-and-layering.md)。

## 提案

### 单向依赖

```text
desktop audio capture
        │ PCM frames
        ▼
interview runtime composition
   ├── VAD / segmenter ── speech boundaries + audio segments
   ├── transcription coordinator ── provider-neutral transcript events
   ├── turn assembler ── interviewer turns
   └── reply workflow ── question decision + cancellable answer run
        │
        └── UI projection ── InterviewChange over typed IPC
```

依赖只向下游流动。VAD 不导入 ASR、LLM、IPC 或 provider 类型；provider 不导入 VAD 实现、UI、LLM 或供应商以外的领域策略；turn assembler 不访问音频采集或网络；reply workflow 不接收 PCM/VAD/供应商事件，只消费已归一化的面试官 turn 和必要的候选人上下文。`interview/runtime.ts` 是唯一组装点，负责连接端口，不承载算法或业务策略。

### Agent 模块

- `interview/contracts.ts`：内部稳定值对象与端口，定义音频帧、VAD 边界、音频段、转录事件、turn 事件、错误和能力元数据。无 Electron、React、provider SDK 或网络协议字段。
- `interview/audio/`：接收会话生命周期就绪后的 PCM 帧，验证格式、session、序号与音频区间，再交给下游音频端口；不做设备采集、VAD、ASR 或回复。首个端到端切片只接系统播放声，并标记为 `interviewer`；候选人麦克风作为后续独立 source 接入。
- `interview/vad/`：VAD 检测器只消费规范 PCM 帧并输出语音开始/结束及置信度；segmenter 独立消费 PCM 帧与语音活动，负责 pre-roll/hangover、低能量强切、边界重叠和段缓存。二者都不决定是否提交 ASR，也不决定是否回答。
- `interview/transcription/`：provider-neutral 会话接口、调度器及 provider adapter。当前 `qwen-http/` 仅接收完整 `AudioSegment`，编码 WAV、发 multipart `/transcribe` 并产出 chunk-final；未来 realtime adapter 可订阅连续 PCM 帧并产出 partial/final。选择输入形态由 coordinator 读取 provider capabilities 完成，不改变 VAD 或 reply 契约。
- `interview/turns/`：按 source、utterance、chunk 序号合并转录，处理 continuation、乱序、重叠去重、turn settle 和 transcript gap；输出 `InterviewerTurnStarted`、`InterviewerTurnUpdated`、`InterviewerTurnCommitted`。模型 chunk final 不等于 turn committed。
- `interview/reply/`：question policy 与 answer workflow 分开。policy 只判断 provisional/committed turn 是否值得回答；workflow 收到归一化的 interviewer `turn-started` 时立即 abort 当前 generation，之后负责过期结果丢弃与文本流映射，不持有音频或 ASR 状态。VAD 不直接调用 reply，也不停止音频采集。
- `interview/runtime.ts`：生命周期与上述模块的组合根；停止时按逆序关闭 provider、队列、VAD 和采集端口，并使该 session 所有迟到结果失效。

### 名词与生命周期

- `conversationId` 表示面试模式沿用的文本对话历史，例如现有 `ActiveExamConversationId`。一次面试期间保持不变；识别文本和 AI 回复继续写入同一对话，不因暂停或重启音频监听而新建对话。
- `sessionId` 表示一次音频监听运行，从采集启动到资源清理完成。停止后重新启动采集时创建新的 `sessionId`，用于隔离新旧音频和迟到的异步结果。它不是对话 ID，也不负责保存历史。
- `utteranceId` 表示 VAD 在某一路音频上识别的一段连续发言；VAD 只产生语音开始/结束边界，不管理对话或监听生命周期。
- 每个 `InterviewSession` 固定关联一个 `conversationId`。轮次事件携带该 `conversationId`，回复 workflow 必须把建议写入该对话。捕获重启创建新的 session 时继续传入原 `conversationId`。

监听状态转换为 `starting → listening → stopping → stopped`；启动或运行错误可从非终态进入 `failed`。只有采集和运行时都就绪才进入 `listening`；只有当前 `sessionId` 处于 `listening` 时才接收音频和异步结果；进入 `stopping` 后在途结果也失效。清理完成后进入 `stopped`。重复 stop 是幂等的。`stopped` 和 `failed` 是终态，重启创建新 `sessionId`，不能复活旧 session。任何携带非当前 `sessionId` 的生命周期事件或异步结果都被忽略。AI 思考/ASR 处理是并行活动，不构成监听状态，因此 UI 的 thinking 不能替代 listening。

首轮批式 Qwen 路径使用 VAD 输出的 `AudioSegment`。达到最大段长时产出 continuation segment，仍立即送 ASR 并允许展示临时建议；只有 VAD 自然闭合且该 utterance 的 segment 全部按序完成，turn assembler 才提交完整 turn。实时 provider 直接消费 PCM 帧，client VAD 仍独立提供发言起止信号，不要求 provider 复用 VAD 算法。打断顺序固定为：可靠的 interviewer `speech-started` → turn assembler 立即发 `turn-started` → reply workflow abort 当前 LLM generation；音频帧采集与转录继续，不等待 ASR 文字，也不因回复取消而停流。candidate source 的 speech-started 不触发 interviewer reply 的打断策略；候选人转录结果可独立进入回答上下文。

### 稳定契约

- `PcmFrame`：`sessionId`、`source`、每路独立从 0 开始的 `sequence`、每路音轨内单调的 `startSample`、`sampleRate`、声道/格式和有界 PCM payload。首轮由 desktop 统一输出 16 kHz、mono、PCM16；帧最长 100 ms（1600 个采样点、3200 字节），停止时最后一帧可以更短。时间位置用 sample frame 表示，不用系统墙上时钟；双路音频无需假定共享 `Date.now()` 基准。
- `SpeechActivityEvent`：source、utterance、`started/ended`、`atSample` 和 0..1 置信度。该事件描述“检测到说话”，不表示 ASR 已经有文本。
- `AudioSegment`：`sessionId`、`source`、`utteranceId`、`chunkIndex`、起止音频时间、PCM16 payload、`boundaryKind: "utterance-end" | "continuation"`。边界重叠长度由 segmenter 配置；去重依据稳定的音频时间范围，不由 provider 或回答模块猜测。
- `TranscriptEvent`：`sessionId`、`source`、`utteranceId`、`chunkIndex`、`revision`、文本、音频起止时间，以及 `kind: "partial" | "chunk-final" | "error"`。错误携带稳定错误码和 retryability，不暴露 HTTP body、模型名或原始服务端错误。
- provider 输入模式显式区分 `segment` 与 `stream`：当前 Qwen HTTP provider 接收完整 `AudioSegment`；未来流式 provider 接收 `PcmFrame` 并异步发出相同的 `TranscriptEvent`。两者共享转录语义，不共享供应商 wire 类型。
- `InterviewerTurn`：由 turn assembler 维护，包含稳定的 `conversationId`、产生该轮的 `sessionId`、有序 transcript、完成状态、缺失 chunk/gap 标记和 generation/version。回答模块将回答写回该 conversation，并仅依据 turn 版本提交或丢弃结果。
- 所有异步回调携带 `sessionId` 和 generation/version；stop、新 turn 或 provider 重建后旧回调只能被丢弃，不能跨模块自行重试或启动回答。

`chunk-final` 只代表该 chunk 文本稳定。turn assembler 同时消费 VAD 的自然 utterance end、分段边界和 ASR chunk 状态，只有末段已识别、前序 chunk 已按序收齐且未发生 transcript gap 时才能发 `InterviewerTurnCommitted`。强切 continuation 不能冒充自然 utterance end。

这些是 Agent 内部契约。worker 通过独立的 `interview-event` 上行帧传递 `InterviewWorkerEvent` DTO；Agent worker adapter 显式从领域事件投影到线协议，desktop main 再投影成 renderer 使用的 `InterviewChange`，各层可独立演进。start/stop/PCM 下行命令要在 Agent 面试运行时能实际消费时再加入，不能先发布无处理逻辑的空命令。IPC ChannelMap 仍按仓库约定集中在 `packages/shared/src/channels.ts`，但不把 provider 事件或 AVP 事件塞入 shared。未来 AVP 网络协议有独立版本、认证和序列化责任，只有网关接入排期后再定稿。

### 并行开发规则

先由集成负责人合并 `contracts.ts`、worker 命令/帧和 UI 投影的接口测试，再并行拆分：VAD/segmenter、Qwen HTTP adapter、turn assembler、reply workflow、desktop capture/IPC、UI projection。每个任务只依赖已合并契约和 mock port；不应为适配另一小组的私有类型而修改对方模块。算法或 provider 替换须通过各自模块测试和同一组 contract test。

跨模块只允许 `runtime.ts` 组合，不允许 `reply` 反向调用 VAD/provider、不允许 provider 直接发 `InterviewChange`、不允许 VAD 拼接网络请求、不允许 UI 或 desktop 解析供应商事件。修改稳定契约时由变更者同步契约测试和 mock；不以共享任意对象/`unknown` 逃避边界。

### 实施顺序与完成门禁

按以下阶段推进。每阶段先合并接口与测试，再并行开发已有契约覆盖的模块；阶段验收不过，不把问题推给下一层兜底。

1. **冻结领域词汇与生命周期。** 统一 `conversationId`（持久对话历史）、`sessionId`（一次监听运行）、`utteranceId`（VAD 语音段）、`source`、`chunkIndex`、音频时间和 `generation` 的含义；画清 start、stop、error、restart 的状态转移。完成内部 contracts 与 worker 事件帧发布测试，不写 VAD/ASR/LLM 实现。renderer IPC projection 在桌面采集接线阶段单独测试。通过条件：监听重启保留 conversationId 并创建新 sessionId；类型不能把 chunk-final 与 turn-committed 混为一谈；停止后旧 session 结果一律不可见。
2. **打牢 PCM 与音频帧边界，并尽早验证采集风险。** 首个接入 source 为 Windows 系统播放 loopback，统一标记为 `interviewer`；候选人麦克风暂不接。为 PCM16、采样率、声道、每帧时长、序号、sample-frame 时间轴和最大 payload 定规格；desktop 负责系统音频格式归一化和固定帧长，Agent `audio/` ingress 在未监听、跨 session、格式错误、重复/倒序或重叠音频时拒绝帧。发现序号或 sample 时间有缺口时，接受后续帧并发布 gap 事件，同时推进游标，避免一次丢帧永久堵住该音轨。先完成 Windows loopback 到 Agent ingress 的最小纵向切片，用可见的开始/停止入口验证权限、音轨与 PCM 输出；随后用固定 PCM fixture 做可重复的帧边界测试。通过条件：同一输入可被逐帧重放，丢帧/队列溢出能观测，聚合缓存与消息大小有硬上限；实机采集与停止能清理所有轨道和音频节点。
3. **独立实现并评估 VAD 与 segmenter。** VAD 检测器只输出 speech activity；segmenter 单独管理 pre-roll、hangover、最大段长、低能量切点、重叠区间、flush 和丢弃。先固定二者接口，再用有标注的静音、短词、停顿、连续长句和噪声样本评估算法；算法选型通过实测决定，不能以 demo 音频调参后宣称可靠。通过条件：边界指标、误触发/漏检、起始辅音保留、最长缓存和尾段行为均有测试及记录，调阈值不改 ASR/reply。
4. **独立打牢 Qwen HTTP adapter。** 输入预制 `AudioSegment` fixture，测试 PCM→RIFF/WAV、multipart 字段、语言、20 MiB/60 秒限制、timeout、503/Retry-After、取消、队列上限与迟到响应。使用假的 HTTP server，不依赖实时采集。通过条件：错误归一化且不泄漏敏感响应，响应乱序能按 segment id 交付，队列饱和不会无限积压。
5. **独立打牢转录聚合与 turn assembler。** 使用手写 transcript event 序列，不连真实 provider；验证乱序/重复/缺失 chunk、重叠去重、continuation、自然结束、turn-settle 超时和 transcript gap。通过条件：只有完整、无缺段的 interviewer turn 能提交最终回答输入；临时 turn 与 committed turn 类型和状态明确区分。
6. **独立打牢 AI 回复 workflow。** 仅依赖 `InterviewerTurnEvent`、question policy、`AnswerGenerator` 和取消端口；fake generator 验证 interviewer `turn-started` 立即取消旧 generation、provisional/committed turn 更新后不采纳旧流、静默问题不回答、候选人音频只补上下文、停止时释放 run。之后再接现有文本模型流，不能让其直接消费 PCM/VAD/provider 事件。通过条件：回复模块测试无需启动 VAD/HTTP，也不修改其测试即可替换 transcript 来源。
7. **由薄 composition root 做组合与故障演练。** 用 fake audio/VAD/provider/generator 测完整生命周期、两个 source 隔离、重启、worker 退出、队列溢出、多个并发回调及清理顺序。通过条件：runtime 只装配和转发明确事件，不出现算法分支或供应商字段。
8. **完成 Windows 集成与产品 UI。** 扩展首轮 loopback 验证，覆盖目标输出设备、会议软件、窗口关闭和隐身行为；候选人麦克风作为独立 source 后续接入。UI 再接入分段识别、turn 与回答状态。通过条件：真实会议样本端到端记录识别准确率、speech-end→转录、speech-end→首条有用建议的 P50/P95、队列高水位和 gap；UI 文案准确标为批式分段识别。

第 1 阶段后，VAD、HTTP adapter、turn assembler、reply workflow 可以由不同开发者并行，各自只依赖已合并 contracts 与 fake ports。desktop capture 和 UI 在 IPC projection 固定后并行。只有集成负责人修改 contracts、worker 命令/帧及 composition root；其余任务不得通过交叉修改模块来赶进度。

## 模块边界

- `packages/shared`：只定义 renderer/main IPC 必需的面试请求、PCM 消息和展示 DTO；不得定义 VAD 内部事件、provider 请求/响应或 AVP wire 类型。
- `apps/desktop`：捕获、设备权限、PCM 格式归一化、会话生命周期和 IPC 校验/转发；不做 VAD 算法、ASR 请求、turn 合并或回答判断。
- `apps/agent/src/interview/vad`：音频活动与分段纯逻辑；无 I/O、模型、UI 或协议依赖。
- `apps/agent/src/interview/transcription`：转录 provider 端口、分段调度与适配；不得触发回答或持有 turn 决策。
- `apps/agent/src/interview/turns`：转录到说话轮次的聚合；不感知 provider HTTP/WS 形态和回答 prompt。
- `apps/agent/src/interview/reply`：判断和回答生成；只依赖 turn/context/model-generation ports，不能持有音频或 provider 生命周期。
- `apps/agent/src/interview/runtime.ts`：组装端口和保证关闭顺序；不发展成多领域万能 service。
- `packages/ui`：消费 `InterviewChange` 并呈现状态、转录、建议；不运行音频/VAD/ASR，也不决定 provider 行为。

## 曾考虑的替代方案

- **把所有状态放进单个 `InterviewRuntime`：** 初期文件少，但 VAD、ASR、turn 与 LLM 取消将互相调用，任何并行改动都会争用状态机；舍弃。保留一个薄 runtime 作为组合根。
- **直接把 OpenAI Realtime/AVP 事件作为内部领域事件：** 当前 Qwen HTTP 无 WS，批式模式没有 partial；把网络协议用作内部类型会迫使 VAD、UI 和回答编造或理解 provider 事件；舍弃。内部事件先按面试领域定义，网络协议以后独立映射。
- **ASR provider 自己实现 VAD 与回答触发：** 可快速跑出 demo，但更换 HTTP/WS provider 会改产品策略，VAD 算法也无法独立评估；舍弃。VAD 只产出音频边界，turn assembler 决定轮次完成，reply workflow 决定回答。
- **让回答工作流直接监听 VAD speech-start 和 transcript delta：** 可以及时取消旧回答，但会让回复模块依赖低层噪声和 ASR partial 语义；舍弃。VAD onset 由 turn assembler 映射为稳定的 interviewer `turn-started` 事件，reply workflow 收到后立即取消旧 run。

## 验收标准

- 依赖测试确认 `vad` 不导入 `transcription`、`reply`、Electron、React 或 `shared`；`transcription` 不导入 `reply`/UI；`reply` 不导入 VAD/provider 实现。
- 阶段门禁逐项通过：契约/PCM/VAD/HTTP adapter/turn/reply/composition/Windows 集成，各阶段保留独立测试和可复现证据；后续阶段不能替代前序模块验收。
- VAD contract tests 使用合成 PCM 验证 pre-roll、hangover、continuation、低能量切分和 stop flush；ASR contract tests 同一输入分别覆盖 Qwen HTTP final、模拟 realtime partial/final、错误/取消/迟到响应。
- Turn tests 验证乱序 chunk、重复结果、缺失 chunk、continuation 与自然 turn end；reply tests 只通过 turn port 驱动，覆盖 question ignore、更新时取消、generation 过期和停止清理。
- 集成测试由 composition root 连接 fake audio、VAD、provider 和 reply ports；替换任一模块实现时其余模块与 contract tests 不需修改。
- Windows 实机验证捕获链路与内网 Qwen HTTP 延迟/准确率；这属于端到端证据，不替代每模块 contract tests。
- `packages/shared` 中不出现 Qwen、DashScope、AVP、VAD 参数或 provider response 结构；Agent 不新增 Electron/React 依赖或本地网络 listener。

## 风险

- Electron loopback 只在 Windows 首轮支持，且 renderer 需要在用户手势下请求 display media；必须保留主进程授权校验，并在采集失败、窗口销毁和显式停止时关闭所有 MediaStreamTrack、AudioWorklet 与 AudioContext。
- UI 当前 `InterviewChange` 同时混合转录与回答状态，是 IPC 展示 DTO 而不是理想内部模型。实施时应由内部领域事件投影生成它，不让 ASR 或 reply 模块直接构造该 union。
- 实时 provider 的服务端端点与客户端 VAD 边界可能不同；通过分别记录 provider segment 与本地 interviewer turn 解决，不能把二者强行合成单一“final”。
- 该拆分会增加少量端口和装配代码；若早期引入通用插件系统、DI 容器或可配置策略框架，会超过当前单一 Qwen provider 的需要，因此暂不引入。

## 当前实现与验证

- 当前代码只完成 Windows loopback 到 desktop PCM 分帧、typed IPC、Agent ingress 校验和下游音频端口转交。UI 状态表示本机采集器状态，不代表 ASR 已工作；VAD、转录和回答尚未接入，因此本 Note 仍是提案。
- 单帧上限为 100 ms / 3200 bytes。AudioWorklet 和 renderer 使用 10 帧 credit 窗口；Agent 每处理 5 帧返还一次额度，额度耗尽时采集端丢弃新帧，序号/采样位置保留缺口。连续 3 秒没有额度返还且仍有在途帧时，采集器报错并释放资源。各异步阶段因此有明确的有限上限，不能在实时处理落后时无限积压。
- 自动化测试覆盖 PCM 格式/时间轴、session 生命周期、IPC 调用来源、启动取消和资源清理。Worker adapter 集成测试使用结构化克隆的 ParentPort 替身连接实际 worker 接线与 Agent host，验证 credit 按批往返、序号缺口可见、监听停止后旧 session 帧不污染重启 session。该测试不等同于 Electron 独立进程或 Windows 设备实测。
- 采集面板将显示 Agent 通过 credit 回执确认处理的 PCM 帧数；worker 只为 ingress 接受的帧返还额度，拒绝帧不能增加确认数。实机验收时播放持续系统声音，确认该数字持续增长；若播放声音时仍为 0，不能判定音频链路通过。
- Windows loopback 尚未在真实音频播放或会议软件下实测；自动化 mock 不能证明系统设备兼容性。进入 VAD 阶段前仍须完成 Windows 实机采集、持续传帧和停止清理验证，并确认真实队列拥塞时序号/采样位置能显示丢帧缺口。
