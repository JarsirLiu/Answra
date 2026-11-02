# Note：airi 实时语音/ASR 参考与面试会议链路取舍

状态：提案

## 问题

面试/会议模式需要实时 ASR，但当前实现是「麦克风单路 + VAD 分段 + 本地 Paraformer 整段解码」：每个 VAD 段只产出 `chunk-final`，没有模型级 partial；turn 的完整性依赖 500ms 静音闭合和 1s settle 窗口，长回答的文本延迟等于说话时长。团队需要参考成熟项目的实时语音链路，但完整 clone `airi` 体积大，且其产品假设（单用户语音陪伴、TTS/播放、浏览器/Vue）与 Answra 的面试场景不同。缺少一份可复用的参考索引和取舍记录，下一次讨论容易重复调研或直接搬错层。

## 涉及范围

- 代码/模块（现状）：
  - 采集与 IPC：`apps/desktop/src/main/interview/interviewIpc.ts`、`apps/desktop/src/main/interview/interviewCaptureService.ts`、`apps/desktop/src/renderer/interviewAudioCapture.ts`。当前只接受 `candidate` 麦克风帧；系统音频 loopback 未接入。
  - 领域链路：`apps/agent/src/interview/audio/ingress.ts`、`apps/agent/src/interview/vad/`、`apps/agent/src/interview/transcription/`、`apps/agent/src/interview/turns/`、`apps/agent/src/worker/host.ts`。
  - IPC/UI：`packages/shared/src/channels/interview.ts`、`packages/ui/src/components/panels/InterviewCapturePanel.tsx`。
- 参考仓库：`D:\codespace\airi`，使用 `git clone --depth 1 --filter=blob:none --no-checkout` + `git sparse-checkout` 只检出语音相关目录；工作区小于 10MB，`.git` 约 2.3MB，MIT。只作架构参考，不新增运行时依赖、不复制代码。
- UI/进程/协议/持久化表面：本 Note 只记录参考与取舍，不改代码、IPC、持久化或用户行为。
- 相关 Note：[面试模式持续监听与回答建议](../feature/2026-10-12-live-interview-assistant.md)、[面试语音识别管线与客户端 VAD 选型](2026-10-16-interview-asr-pipeline-and-vad.md)、[面试语音运行时模块边界与并行开发契约](2026-10-19-interview-runtime-module-boundaries.md)、[turn 端点判定层](2026-10-22-turn-endpoint-judge-layer.md)、[Answra 实时语音识别私有协议（AVP）v1](2026-10-16-answra-voice-protocol-avp-v1.md)。

## 提案

### 参考结论

只取与面试 ASR 相关的部分，不把 airi 的语音陪伴产品形态一起搬过来。airi 的链路可以概括为五层：

1. **共享音频输入。** `packages/pipelines-audio/src/audio-input.ts` 用 `AudioInput` 共享一个 live source；第一个订阅者打开麦克风，最后一个离开才关闭。每个订阅有独立 abort 和缓冲上限，慢消费者只失败自己。`retain/hold` 保留 VAD onset 之前的 pre-roll，`capture` 把「一次发言」表示成有开始/结束的连续 PCM 区间。
2. **provider 无关的流式转写。** `packages/core-agent/src/voice/input/attempt.ts` 把 capture 的 PCM 流直接交给 `provider.transcribe({ audio, signal })`，边录边读。`packages/stage-ui/src/libs/audio/hearing-transcriber.ts` 把 provider 的 `delta` 和 `snapshot` 统一成完整文本 revision：每次 `update` 带递增 `revision` 和 `segments[].final`，最后 `complete` 必须与该 revision 的最终文本一致。`packages/stage-ui/src/libs/providers/stream-transcription/index.ts` 是 SSE adapter，负责把网络分块解析成同一套 delta/snapshot 事件。
3. **VAD 与 turn 策略分离。** `packages/core-agent/src/voice/policy/rules.ts` 里 VAD 只回答「当前窗口有没有人声」；`pause` 规则单独判断停顿，`end-judge` 再决定是否 seal。慢判断携带 `readAt`，如果判断读取的文本或活动 revision 已经变化，结果作废。这比「静音即 turn end」多一层语义判断。
4. **打断与失效。** `packages/core-agent/src/voice/controller.ts` 的 `interrupt` 先让目标回答的播放静音/失效，再记录中断事件；音频采集和转写继续。回答侧用 turn identity 和 generation 丢弃迟到结果。
5. **UI 的稳定前缀 + 易变后缀。** `packages/stage-ui/src/composables/use-streaming-transcription-input.ts` 只替换输入框尾部的 volatile 转写，稳定前缀保持不动，避免 partial 刷新造成整段文字闪烁。

provider 传输有两种形态，可按部署条件选择：`server/apps/api/src/routes/audio-transcription-stream/session.ts` 把阿里云 NLS 的 WebSocket 转成 SSE；`packages/stage-ui/src/libs/providers/providers/aliyun-nls/provider.ts` 则在客户端直连 WS。两者最终都输出同一套转写语义，上层不感知上游协议。

### 映射到 Answra

| 关注点 | airi 参考 | Answra 现状 | 建议 |
| --- | --- | --- | --- |
| 音频输入 | `AudioInput` 多订阅 + pre-roll | desktop 采集，credit 窗口限流；当前只有 `candidate` | 保留 credit 背压；每路 source 独立 VAD/ASR |
| VAD | Silero 窗口 + policy | TEN VAD，500ms 闭合、4.5s 强切、300ms pre-roll | 保留 TEN VAD 与现有参数 |
| 转写 | `StreamingTranscriber` 产 partial/final | `LocalParaformerAdapter` 每段一次性 `chunk-final` | 实现契约里已预留的 `inputMode: "stream"` |
| turn | 规则 + `readAt` 失效 | assembler 等 `utterance-end`，settler 1s 合并 | 增加端点判定，不再让 500ms 静音直接决定提交 |
| 打断 | controller interrupt | `reply-invalidated` + generation 已有 | 用可靠的 interviewer onset 触发 abort，不停采集 |
| 传输 | WS→SSE 中转 / 客户端直连 | 尚无 realtime provider | WS client 放 agent/main，不放 renderer |

### 建议采纳顺序

1. **先实现流式转写契约，不换引擎也可以先接。** `apps/agent/src/interview/contracts.ts` 已经定义了 `inputMode: "stream"` 和 `openSession`，但没有实现。新增 adapter 应持续消费某一路的 `PcmFrame`，产出：
   - `partial`：同一 `(utteranceId, chunkIndex)` 的中间文本，`revision` 单调递增，后到的覆盖先到的；
   - `chunk-final`：该 chunk 文本稳定，继续走现有 assembler；
   - `error`：沿用现有错误码和 retryable 语义。
   `InterviewTurnAssembler` 当前已经忽略 `partial`，所以 partial 只影响 UI 投影，不会把半句写进对话。`InterviewChange.transcript.final` 也已经有展示位置。
2. **VAD 只负责活动检测，turn end 单独判断。** 保持 TEN VAD 和 500ms 闭合，把「何时问端点模型」与「何时提交」拆开；端点判断只在静音期运行，结果必须带读取时的文本 revision，文本变了就丢弃。不要照搬 airi 的 1200ms 默认静音，它是语音陪伴场景的取值。
3. **双路音频按 source 隔离。** `interviewer`（系统 loopback）触发回答，`candidate`（麦克风）只作为上下文；每路独立的 VAD、segmenter、transcription session 和 turn 状态。airi 的 `AudioInput` 多订阅模式可以借鉴，但它本身没有系统 loopback，Electron/Windows 的采集与权限仍按本仓库方案实现。
4. **打断只 abort 回答，不停音频。** interviewer 的可靠 speech onset 到达时，用现有 generation 使当前回答失效并 abort LLM；采集、VAD、ASR 保持运行。不要把「取消 LLM」实现成「停止监听」。
5. **凭证与传输放在 agent/main。** 若接云端 WS，连接、token 和重连都留在 agent 或 desktop main；renderer 只收投影事件。airi 的 WS→SSE 中转可以作为网关形态参考，产品方向仍以 [AVP v1](2026-10-16-answra-voice-protocol-avp-v1.md) 为准。
6. **UI 只消费 projection。** partial 用稳定前缀 + 尾部替换；不要把 partial 追加进对话历史，也不要让 UI 自己合并 turn。

### 明确不做

- 不引入 airi 的 Vue/Pinia/TTS/播放/Live2D 运行时，也不把它的包作为依赖。
- 不照搬 airi 的 VAD 阈值、1200ms 静音策略和 sentence-index segment 身份；Answra 的 `utteranceId + chunkIndex + 采样区间` 更适合面试 turn。
- 不把批式 Paraformer 的结果伪造成 partial；没有模型级中间结果就不发 `partial`。
- 不把系统 loopback 说成 airi 的参考能力；它没有面试式双路采集。
- 不把 provider wire 类型放进 `packages/shared`，也不让 renderer 直接持有云端 ASR 凭证。

## 模块边界

- `apps/desktop`：采集、权限、PCM 格式归一化、credit 背压和 IPC 校验；不解析转写语义、不做 turn 决策。
- `apps/agent`：VAD、流式 adapter、turn 聚合/端点策略、回答失效；不依赖 Electron/React，引擎只经端口注入。
- `packages/shared`：只承载 renderer/main 的 IPC DTO 和频道；不出现 provider 事件、模型名或 AVP wire 类型。
- `packages/ui`：只把投影事件渲染成状态、partial 和最终消息；不运行音频/VAD/ASR，也不决定提交时机。
- `D:\codespace\airi`：只作为本地参考索引，不进入仓库、不进入构建、不进入依赖图。

## 曾考虑的替代方案

- **整体移植 airi 的 voice pipeline：** 舍弃。它把采集、VAD、转写、turn policy、播放、TTS 和 UI 状态绑在 Vue/Pinia/浏览器运行时里，且核心场景是单用户语音陪伴；Answra 需要的是 Electron 双路采集、面试 turn 和文字建议，直接移植会把无关的产品假设和运行时依赖带进来。
- **继续批式 Paraformer，只调 VAD 和 settle 参数：** 舍弃作为「实时化」方案。批式每段必须等 VAD 闭合或 4.5s 强切后整段解码，模型没有中间结果；调参数只能减少碎句，不能产生 partial，也不能降低「说话时长 = 文本延迟」这一上限。它可以保留为 fallback，但不能对外称为 realtime。
- **采用 airi 的 sentence-index segment 身份：** 舍弃。airi 为了 UI 输入框的文本替换，按 `Intl.Segmenter` 的句子下标重建 segment；Answra 的 assembler 依赖 `utteranceId`、`chunkIndex` 和采样区间做乱序合并、continuation 去重和 turn 完整性判断，换成句子下标会丢失音频证据。
- **用批式 Paraformer 伪造 partial：** 舍弃。把整段结果按时间切片重复发送，只是把延迟换皮，文本仍要等整段解码；它会让 UI 和 turn policy 误以为存在模型级中间结果，破坏「partial 可撤销、final 才提交」的语义。
- **让 renderer 直连云端 ASR WebSocket：** 舍弃。凭证会进入 renderer 可见面，权限和重连策略也会分散到 UI；与现有「desktop main 持有权限、agent 持有领域语义」的边界冲突。

## 验收标准

- 可观察结果：从本 Note 的参考索引能在 10 分钟内定位 airi 的采集、流式转写、VAD/policy、打断、provider 传输五段；每条建议都标出现状与目标，不把未实现能力写成已交付。
- 自动化验证：`pnpm notes:check` 通过；本 Note 的本地链接全部存在；本变更不新增依赖、不改代码、不改 IPC。
- 需要的实机验证（后续实施时）：Windows loopback + 带标注的中英文面试样本，记录 partial 首字延迟、`speech-end → final` 文本延迟、CER、轮内误切率和打断误触发率；未完成前不宣称实时化达标。

## 风险

- airi 是单用户语音陪伴，不是会议/面试；它的 turn policy 和 VAD 参数不能直接移植。
- 本地流式引擎（如 sherpa-onnx online recognizer）的体积、性能、许可和中文准确率尚未实测；现役 Paraformer 是 offline 模型，不能直接变成 streaming。
- 云端 WS 会引入凭证、网络、重连和计费面；若放错进程会泄露 key 或让 renderer 承担重连状态。
- 双路采集的系统 loopback 是 Electron/Windows 特有问题，airi 没有参考实现；权限、设备切换和回声/串声仍需单独实测。
- partial 会增加 UI 刷新和 turn policy 的并发面；如果没有 revision/过期丢弃，旧结果可能覆盖新文本。
- airi 是 MIT，复制代码需要保留版权声明；本 Note 只参考架构，不构成对任何具体实现的产品适配证明。

## 验证证据

- 参考仓库获取方式（2026-11-02）：`git clone --depth 1 --filter=blob:none --no-checkout --single-branch https://github.com/moeru-ai/airi.git airi`，随后 `git sparse-checkout set` 只检出语音相关目录；工作区小于 10MB，`.git` 约 2.3MB。`LICENSE` 为 MIT。
- airi 侧已核对文件：`packages/pipelines-audio/src/audio-input.ts`、`packages/core-agent/src/voice/input/attempt.ts`、`packages/stage-ui/src/libs/audio/hearing-transcriber.ts`、`packages/stage-ui/src/libs/providers/stream-transcription/index.ts`、`packages/core-agent/src/voice/policy/rules.ts`、`packages/core-agent/src/voice/controller.ts`、`packages/stage-ui/src/composables/use-streaming-transcription-input.ts`、`server/apps/api/src/routes/audio-transcription-stream/session.ts`、`packages/stage-ui/src/libs/providers/providers/aliyun-nls/provider.ts`；设计背景见 `docs/ai/adr/2026-10-16-voice-input-layers.md`、`docs/ai/adr/2026-10-16-voice-plugins-watch-and-finalize.md`。
- Answra 现状核对（2026-11-02）：`apps/desktop/src/main/interview/interviewIpc.ts:127` 与 `apps/desktop/src/main/interview/interviewCaptureService.ts:75` 只接受 `candidate`；`apps/desktop/src/renderer/interviewAudioCapture.ts:105` 只请求麦克风；`apps/agent/src/interview/vad/config.ts:18` 起为 500ms/4.5s/300ms；`apps/agent/src/interview/transcription/local/adapter.ts:42` 为整段批式解码；`apps/agent/src/interview/contracts.ts:109` 已预留 `stream` 输入模式但无实现；`apps/agent/src/interview/turns/assembler.ts:29` 只聚合 `candidate`；`apps/agent/src/interview/turns/settler.ts:27` 为 1s settle。
- 既有评测与决策：[VAD turn-end 评测](../../implemented/testing/2026-10-21-vad-turn-latency-evaluation.md)、[candidate 轮次 settle 合并](../../implemented/feature/2026-10-22-candidate-turn-settle-merging.md)、[LocalParaformerAdapter](../../implemented/feature/2026-10-21-local-paraformer-adapter.md)、[VAD turn-end 闭合窗修复](../../implemented/bug-fix/2026-10-21-vad-turn-end-close-window.md)。
- 本 Note 为参考与提案，未改代码；实时 partial、双路 loopback 和端点判定的实机数据尚未产生。
