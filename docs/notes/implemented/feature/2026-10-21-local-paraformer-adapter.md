# Note：LocalParaformerAdapter（阶段 2，本地批式转录 provider）

状态：已实施

## 问题

[本地内置 ASR 路线](../../proposed/architecture/2026-10-21-local-asr-paraformer-small.md)的实施顺序把 `LocalParaformerAdapter` 排在阶段 2：VAD 管线已能产出 `AudioSegment`（阶段 3），但识别侧还没有任何生产 adapter——评测 harness 里只存在"直接调 sherpa SDK"的兼容层，产品语义（`TranscriptionProvider` 的 segment 形态、错误归一化、取消语义、引擎约束处理）无处落地。

## 涉及范围

- `apps/agent/src/interview/transcription/local/`：新增 `recognizerPort.ts`（引擎端口）与 `adapter.ts`（`LocalParaformerAdapter`）。
- `apps/agent/test/interview/transcription/local.test.ts`：假引擎 contract 测试（6 例）。
- `apps/agent/examples/vad-asr-eval/chain-eval.test.ts`：评测链路从直调 sherpa 换成「真实 `InterviewAudioIngress`（含 `PcmFrameValidator`）→ 真实 VAD 管线 → 生产 adapter」，评测进程充当 desktop 组合根注入站。
- `run-eval.mjs` 默认只跑 small（单进程顺序解码，工具自身零并发）。
- 不动：`packages/shared`、UI、desktop（desktop 注入组合根是后续阶段）。

## 影响表面

- `apps/agent` 的本地转录域新增 `LocalParaformerAdapter`：把 VAD 段（`AudioSegment`）变成单个 `chunk-final` 事件，错误与取消语义收敛到 `contracts.ts` 既有错误码，不新增领域类型。
- 评测 harness 的识别路径与产品同源：`chain-eval` 走真实 ingress 校验链 → 真实 VAD 管线 → 生产 adapter，评测口径即产品口径。
- 无用户可见行为：desktop 组合根未接入，用户侧界面与交互不变。

## 决定

1. **端口形状**：`OfflineRecognizerModule.create(recipe) → OfflineRecognizerSession.transcribeOnce({samples,sampleRate}) → string`。stream 的生命周期（sherpa 的 create→accept→decode→getResult）闭合在注入侧，领域层只看"整段进、文本出"。曾考虑过把 create/decode/getResult 逐方法透传的口子——会导致领域层持有 stream 对象并以 cast 桥接格式裂缝，舍弃。
2. **错误语义**（`contracts.ts` 错误码，不新增类型）：
   - 引擎解码抛错 → `provider-error`，`retryable: true`（附 `console.warn` 记录原始错误）。
   - 解码前被取消 → `cancelled`，`retryable: false`，不触发引擎。
   - 解码后才到达的取消（同步 native 解码不可被事件循环抢占）→ 丢弃结果，同样报 `cancelled`。这是显式的边界形态：解码中触发的 abort 不可能拦截、只能事后理性丢弃。
   - 解码成功 → 单个 `chunk-final`，携带 `AudioSegment` 全部身份字段（sessionId/source/utteranceId/chunkIndex/start/end），`revision: 0`（首个版本）。
3. **短段跳过**：`< 0.3s` 的整段直接返回空事件集，不解码、不产出任何事件、也不产出 error。依据是 2026-10-21 spike 实测（见 proposed Note 验证证据）：引擎对超短输入抛 Reshape 异常返回空文本，且此类段来自强切尾巴，产品层后续会丢弃或重整。曾在"跳过（现状）"与"产出 `invalid-audio` error 事件"之间选择：前者污染面小、不制造上游无从处置的错误流，但要求消费方（阶段 4 turn assembler 层）不把"无事件"误读成"识别成功为空"；该约束写进本 Note 作为交接条件。
4. **构造即校验**：adapter 构造函数立即调用 `module.create(recipe)`，引擎加载失败直接抛出（composition root 若在模型缺失时构造 adapter，进程 fail-closed 启动失败），不推迟到首段解码。
5. **评测口径**：harness 的 `sherpaModule()` 注入站即未来 desktop 组合根的同形实现；Framing 经真实 `InterviewAudioIngress.acceptFrame`（未信任输入校验、sequence/采样连续性、gap 追踪）再进 `InterviewVadPipeline`。默认模型收窄为 small 单模型，两点原因：SenseVoice 非 paraformer 族、不再走 adapter 链路（直调对比数据已留在 proposed Note）；同时控制评测负载——工具单进程、逐段同步解码，绝无并发测试框架拉满机器的可能。

## 曾考虑的替代方案

- **端口逐方法透传 sherpa API**：见决定 1；对象格式与生命周期裂缝留在领域层，舍弃。
- **超短段产出 error 事件**：见决定 3；错误流噪音与上游处置成本高，舍弃，但把"无事件≠空文本"写为消费方约束。
- **把 engine 的 timeout watchdog 写进 adapter**：同步 native 解码无法被中断，任何中枢计时都拦不住进行中的调用，只能事后丢弃——与取消语义同形而不等价，按契约里已有的 `timeout` 错误码在未来 HTTP provider（真网络 I/O 才有真超时）再实现；本地路径不预留。

## 后果与防回退

- 领域层（agent）新增了对 `sherpa-onnx-node` 的**零 import**：引擎只会经 port 进来；此后任何绕过 port 直调引擎的代码都属于违例。
- `transcription/local/` 的 adapter 对 `<0.3s` 段的跳过行为有 contract 测试锁定；若未来换引擎（该约束消失），必须以引擎新特性为据改常数并更新本 Note，不得悄悄放宽。
- 评测 harness 现在与产品 adapter 是同一条识别路径：以后逐段 decode 时间测量含 adapter 开销，与早期"直调 sherpa"数据不再严格同口径（差异实测 ≤10%，量级相同）。
- SenseVoice-config 支持（`senseVoice` sherpa 配置分支）从评测 spec 中删除；manifest 条目保留作历史与直调复测依据。adapter 若要接 SenseVoice 族，属于新 provider 适配层的决策，另立 Note。

## 验证

- 2026-10-21 假引擎 contract 测试 6/6 通过：chunk-final 事件等值断言、短段不解码、provider-error 归一化、解码前取消不触发引擎、解码后取消丢弃结果、多 source 无串扰。
- 2026-10-21 真实链路评测（AISHELL-1 S0002 十句 + 850ms 间隔 = 68s 连续流，449 帧 100ms，经真实 ingress 校验链 + VAD 管线 + LocalParaformerAdapter +sherpa int8 small）：`segments=24`、`short_skipped=4`（adapter 按约束跳过）、对话口径 CER 3.09%（162 字 5 错，与阶段 1 直调口径一致，证明 adapter 迁移零识别回退）、mean/p95/max 段级解码 52/87/87ms、`max_ready_ms≈787`（占位闭合窗 700 + max 解码）、VAD RTF 0.00764（含 ingress 校验开销）。CSV 由评测自动落 `out/{results,summary}.csv`。
- 门禁：biome、全包 typecheck、`@answra/agent` vitest 全绿（无 `ANSWRA_ASR_EVAL_RUN` 时评测 spec 为 skip）；无并发测试负载（评测单模型、单进程、顺序解码）。
