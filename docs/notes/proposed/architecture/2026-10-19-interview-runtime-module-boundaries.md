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
- `interview/vad/`：VAD 状态机、pre-roll/hangover、低能量强切和段缓存。输入规范 PCM 帧，输出 `SpeechActivity` 与带时间范围的 `AudioSegment`；不决定是否提交 ASR，也不决定是否回答。
- `interview/transcription/`：provider-neutral 会话接口、调度器及 provider adapter。当前 `qwen-http/` 仅接收完整 `AudioSegment`，编码 WAV、发 multipart `/transcribe` 并产出 chunk-final；未来 realtime adapter 可订阅连续 PCM 帧并产出 partial/final。选择输入形态由 coordinator 读取 provider capabilities 完成，不改变 VAD 或 reply 契约。
- `interview/turns/`：按 source、utterance、chunk 序号合并转录，处理 continuation、乱序、重叠去重、turn settle 和 transcript gap；输出 `InterviewerTurnStarted`、`InterviewerTurnUpdated`、`InterviewerTurnCommitted`。模型 chunk final 不等于 turn committed。
- `interview/reply/`：question policy 与 answer workflow 分开。policy 只判断 committed/updated turn 是否值得回答；workflow 负责 generation id、AbortSignal、过期结果丢弃与文本流映射，不持有音频或 ASR 状态。
- `interview/runtime.ts`：生命周期与上述模块的组合根；停止时按逆序关闭 provider、队列、VAD 和采集端口，并使该 session 所有迟到结果失效。

首轮批式 Qwen 路径使用 VAD 输出的 `AudioSegment`。达到最大段长时产出 continuation segment，仍立即送 ASR 并允许展示临时建议；只有 VAD 自然闭合且该 utterance 的 segment 全部按序完成，turn assembler 才提交完整 turn。实时 provider 直接消费 PCM 帧，client VAD 仍独立提供发言起止与回答打断信号，不要求 provider 复用 VAD 算法。

### 稳定契约

- `PcmFrame`：`sessionId`、`source`、单调 `sequence`、`capturedAtMs`、`sampleRate`、声道/格式和有界 PCM payload。首轮由 desktop 统一输出 16 kHz、mono、PCM16；每帧目标约 100 ms，避免高频 IPC 与超大消息。
- `AudioSegment`：`sessionId`、`source`、`utteranceId`、`chunkIndex`、起止音频时间、PCM16 payload、`boundaryKind: "utterance-end" | "continuation"`。边界重叠长度由 segmenter 配置；去重依据稳定的音频时间范围，不由 provider 或回答模块猜测。
- `TranscriptEvent`：`sessionId`、`source`、`utteranceId`、`chunkIndex`、`revision`、文本、音频起止时间，以及 `kind: "partial" | "chunk-final" | "error"`。错误携带稳定错误码和 retryability，不暴露 HTTP body、模型名或原始服务端错误。
- `InterviewerTurn`：由 turn assembler 维护，包含有序 transcript、完成状态、缺失 chunk/gap 标记和 generation/version。回答模块仅依据其版本提交或丢弃结果。
- 所有异步回调携带 `sessionId` 和 generation/version；stop、新 turn 或 provider 重建后旧回调只能被丢弃，不能跨模块自行重试或启动回答。

这些是 Agent 内部契约。desktop worker 命令帧只做面试 start/stop/PCM 输入及面试 UI event 输出；`InterviewChange` 是 renderer 所需的投影，可独立于内部事件演进。IPC ChannelMap 仍按仓库约定集中在 `packages/shared/src/channels.ts`，但不把 provider 事件或 AVP 事件塞入 shared。未来 AVP 网络协议有独立版本、认证和序列化责任，只有网关接入排期后再定稿。

### 并行开发规则

先由集成负责人合并 `contracts.ts`、worker 命令/帧和 UI 投影的接口测试，再并行拆分：VAD/segmenter、Qwen HTTP adapter、turn assembler、reply workflow、desktop capture/IPC、UI projection。每个任务只依赖已合并契约和 mock port；不应为适配另一小组的私有类型而修改对方模块。算法或 provider 替换须通过各自模块测试和同一组 contract test。

跨模块只允许 `runtime.ts` 组合，不允许 `reply` 反向调用 VAD/provider、不允许 provider 直接发 `InterviewChange`、不允许 VAD 拼接网络请求、不允许 UI 或 desktop 解析供应商事件。修改稳定契约时由变更者同步契约测试和 mock；不以共享任意对象/`unknown` 逃避边界。

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
- **让回答工作流监听 VAD speech-start 和 transcript delta：** 可更早取消旧回答，但让回答实现依赖低层噪声/partial 语义；舍弃。由 reply workflow 消费稳定的 `InterviewerTurnStarted/Updated/Committed` 事件，并以版本取消旧 run。

## 验收标准

- 依赖测试确认 `vad` 不导入 `transcription`、`reply`、Electron、React 或 `shared`；`transcription` 不导入 `reply`/UI；`reply` 不导入 VAD/provider 实现。
- VAD contract tests 使用合成 PCM 验证 pre-roll、hangover、continuation、低能量切分和 stop flush；ASR contract tests 同一输入分别覆盖 Qwen HTTP final、模拟 realtime partial/final、错误/取消/迟到响应。
- Turn tests 验证乱序 chunk、重复结果、缺失 chunk、continuation 与自然 turn end；reply tests 只通过 turn port 驱动，覆盖 question ignore、更新时取消、generation 过期和停止清理。
- 集成测试由 composition root 连接 fake audio、VAD、provider 和 reply ports；替换任一模块实现时其余模块与 contract tests 不需修改。
- Windows 实机验证捕获链路与内网 Qwen HTTP 延迟/准确率；这属于端到端证据，不替代每模块 contract tests。
- `packages/shared` 中不出现 Qwen、DashScope、AVP、VAD 参数或 provider response 结构；Agent 不新增 Electron/React 依赖或本地网络 listener。

## 风险

- 当前 `InterviewAudioFrame` 只有 base64 PCM 与 speaker，缺少序号、时间戳和音频格式；真实实现前须通过契约变更补齐，否则乱序、重采样和段边界无法可靠诊断。
- UI 当前 `InterviewChange` 同时混合转录与回答状态，是 IPC 展示 DTO 而不是理想内部模型。实施时应由内部领域事件投影生成它，不让 ASR 或 reply 模块直接构造该 union。
- 实时 provider 的服务端端点与客户端 VAD 边界可能不同；通过分别记录 provider segment 与本地 interviewer turn 解决，不能把二者强行合成单一“final”。
- 该拆分会增加少量端口和装配代码；若早期引入通用插件系统、DI 容器或可配置策略框架，会超过当前单一 Qwen provider 的需要，因此暂不引入。
