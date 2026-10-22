# Note：麦克风采集显式钉死浏览器音频处理约束

状态：已实施

## 问题

面试麦克风采集通过 renderer 的 `getUserMedia` 拿裸流，此前用 `{ audio: true }`（`apps/desktop/src/renderer/interviewAudioCapture.ts`）。用户在开放办公环境（无耳机）试用时观察到转录出现碎句与远处人声混入，最初我方误判为“没有任何降噪在跑”，并提出“开启浏览器内置降噪”作为改善项。

事实核对（Chromium 源码 `content/renderer/media/stream/media_stream_audio_processor_options.h`，2026-10-22 在线核对）：`AudioProcessingProperties` 默认值为 `echo_cancellation_type = kEchoCancellationAec2`、`goog_noise_suppression = true`、`goog_auto_gain_control = true`，且 Chromium 自 M37 起“应用未指定约束时，Chrome 施加合理默认值”。因此当前代码并非“没有降噪”——浏览器侧 AEC/NS/AGC 已经默认生效。

## 涉及范围

- 代码/模块：`apps/desktop/src/renderer` 麦克风采集约束；`apps/desktop/test/interviewAudioCapture.test.ts` 断言。
- UI/进程/协议/持久化表面：无用户可见行为变化；无 IPC/协议/持久化影响。
- 相关 Note：[面试实时语音人工试用闭环](../feature/2026-10-22-live-audio-test-loop.md)、[面试 ASR 管线与 VAD 提案](../../proposed/architecture/2026-10-16-interview-asr-pipeline-and-vad.md)。

## 流程变化

- 麦克风采集行为来源从“Chromium 隐式默认”改为“代码显式声明”：后续开启/关闭 `autoGainControl`/`echoCancellation`/`noiseSuppression` 任一项，都必须先以 Note 重新推导，不允许静默改回 `{ audio: true }`。
- 本条同时修正一处错误认知记录：此前口头表述“本仓库没有任何降噪在跑”不成立，浏览器侧处理链自始默认生效；后续讨论降噪路线（RNNoise/DFN 等）必须以这个事实为前提。

## 决定

把三个音频处理约束从“依赖默认值”改为显式 `{ autoGainControl: true, echoCancellation: true, noiseSuppression: true }`：行为与 Chromium 默认一致，但防止设备/浏览器版本默认值漂移，并使采集意图可审计。不引入 RNNoise wasm 或其他本地降噪模型。

## 曾考虑的替代方案

- **RNNoise wasm 降噪层**：舍弃（当前不采用）。RNNoise 模型固定在 48 kHz / 480 样本帧口径，接入需把 `AudioContext` 从 16 kHz 升到 48 kHz 并在 worklet 内自行重采样，是一次采集管线手术；收益与浏览器 NS（同为 NN 级降噪）重叠明显。若实测浏览器 NS 后仍不达标，再基于 `vad-asr-eval` 真实样本对比评测决定是否值得这次改造。
- **换 16 kHz 原生降噪模型（GTCRN/SpeexDSP wasm）**：舍弃（当前）。交集（16k 原生 + 小模型 + 浏览器可跑 + 有实证）没有现成好选项，评估成本不低于 48k 改造。
- **依赖 OS/硬件 DSP 并不动代码**：舍弃。行为依赖默认值不可审计，也不防版本漂移。

## 后果与防回退

- 本决定不消除远处人声：“附近同事说话”是人声，浏览器 NS 的目标是平稳噪声（风扇、键盘类），对它无效。碎句混入的根治方向是**通道归属**（interviewer 声音走系统环路，麦克风只归 candidate）与**轮次判定**（turn EOU/最小有效轮过滤），不是再加降噪层；不要把“再加一个降噪模型”当作对远处人声的正确回应。
- 采集约束必须显式写全三项为 `true`；若未来要关某一项，须先在 Note 里重新推导，不许静默改回 `{ audio: true }`。

## 风险

- Chromium 默认值以当前源码与其他摸索为准，Electron 的具体 Chromium 版本可能滞后；显式约束恰恰使这个风险失去爆炸面。
- NS/AGC 对 ASR 输入的影响（增益波动等）未做过离线 A/B；若后续评测怀疑处理链改变了语音特征，可用 `track.getSettings()` 复核实际生效值。

## 验证

- Chromium 源码与 issue 记录在线核对（2026-10-22）：M37 起 `getUserMedia` 无约束即应用默认音频处理；`AudioProcessingProperties` 默认字段如上。
- `pnpm --filter @answra/desktop exec vitest run test/interviewAudioCapture.test.ts`：3 项通过，断言约束显式三真。
- `pnpm verify`：lint、全 workspace typecheck、四包测试与架构守护全部通过。
- Windows 实机的听感差异未宣称有改善：按本 Note 决定，该变更确定性钉死既有行为，不承诺用户可感知变化。
