# Note：turn 端点判定层（语义端点模型 + 整轮一次转写）

状态：提案

## 问题

面试模式里用户拿不到"什么时候该把文本发给 AI"的判据，实测表现为两类缺陷：同一句话被切成多条碎消息上屏（"你是谁 / 嗯 / 即将改动 / 提交改动"），以及说话人换气、迟疑产生的停顿被当成句尾。已实施的 [candidate 轮次 settle 合并](../../implemented/feature/2026-10-22-candidate-turn-settle-merging.md) 定位根因是"utterance 即消息"的投影粒度错误，并用 1 秒合并窗口做了表层修复。继续追根因，当前链路还有两处结构性问题：

1. **端点判定只有能量信息。** TEN VAD 只回答"现在安静了吗"（`apps/agent/src/interview/vad/config.ts:21` 的 `VAD_CLOSE_SILENCE_MS = 500`）。句中换气与真正说完了在能量上不可区分——离线评测同一批 38 轮样本的 EOT 召回 89.47%、F1 73.91%，但轮内误切 17/86（19.77%），500ms 是"偏实时"的暂定值（见 [VAD turn-end 闭合窗修复记录](../../implemented/bug-fix/2026-10-21-vad-turn-end-close-window.md) 与 [真实样本评测记录](../../implemented/testing/2026-10-21-vad-turn-latency-evaluation.md)）。settle 的 1 秒窗口是"赌"出来的固定等待：赌赢了合并，赌输了就是 1 秒延迟 + 仍然可能误切。
2. **转写粒度等于分段粒度。** VAD 段长上限 4500ms（`VAD_MAX_CHUNK_MS`）在最低 RMS 处强切，每段**独立**送 Paraformer 解码，段间零上下文 → 切点附近的字词被切碎、标点按片产生；assembler 又要求 utterance-end 且所有 chunk 到齐才提交（`apps/agent/src/interview/turns/assembler.ts:60`）→ 长回答的文本延迟等于说话时长。用户在 VAD 段上感知到的"语音不对"就是这条链路的直接产物。

也就是说：**"何时发"缺一个语义信号（说完了没有），"发什么"缺一个上下文完整的转写单位（整轮而不是片段）**。这两件事都不该继续用固定窗口和强切去凑。

## 涉及范围

- 代码/模块：新增 `apps/agent/src/interview/turns/endpoint/`（端点判定门 + 整轮缓冲）；`apps/agent/src/interview/contracts.ts`（新增 judge 端口类型）；`apps/agent/src/interview/transcription/local/`（整轮音频作为转写输入形态，复用现有 `RecognizerSource` 端口）；`apps/agent/src/worker/host.ts`（接线）；`apps/desktop/src/main/interview/`（judge 组合根）；`apps/desktop/native/asr-resources.json`（资源清单同款新增条目与准备脚本入口）。
- UI/进程/协议/持久化表面：worker 线协议**不新增事件**；`transcript-event` 的产出节奏从"逐 VAD 段"变为"每轮一次"（desktop 投影与 UI 需复核是否需要轮次标记）；音频仍只在内存、不落盘；安装包新增随包二进制约 8MB（judge 权重）加 ORT-WASM 运行时。
- 相关 Note：[面试实时语音人工试用闭环](../../implemented/feature/2026-10-22-live-audio-test-loop.md)、[本地 Paraformer adapter](../../implemented/feature/2026-10-21-local-paraformer-adapter.md)、[面试语音 VAD 选型与 Agent 内适配器](2026-10-20-interview-vad-silero-runtime.md)、[面试语音识别管线与客户端 VAD 选型](2026-10-16-interview-asr-pipeline-and-vad.md)、[本地内置 ASR 路线与 Paraformer-zh-small int8 首选](2026-10-21-local-asr-paraformer-small.md)、[VAD segmenter continuation 挖洞缺陷复盘](../../implemented/bug-fix/2026-10-21-vad-segmenter-continuation-hole.md)。

## 提案

### 1. 职责划分（本次只解决前两行）

| 关注点 | 承担者 | 判据形式 |
| --- | --- | --- |
| 现在有没有人声 | TEN VAD（不变） | 有声/无声边沿 + 段分片 |
| **这轮说完了吗** | **新增端点判定模型** | 一个概率 |
| 这一轮说了什么 | 整轮一次转写 | 一段完整文本 |
| 这轮值不值得发给 AI | 规则层（另一篇 Note） | 放行/丢弃 |

### 2. 端点判定模型选型：smart-turn v3.2

- 结构与体积：Whisper-Tiny 编码器 + 线性分类头，约 8M 参数；ONNX int8 **8MB**、fp32 33MB；许可 BSD-2-Clause，权重、数据与训练脚本均开放。
- 语言：覆盖 23 语种**含中文**；官方基准中文准确率 88.57%（v3.0，945 样本，误切 4.76% / 漏切 6.67%）；v3.2 官方称短句准确率提升约 40%、噪声环境增强。短音频（<1s 段）官方基准明显更差（F1 67%、漏切 20%），因此**短段不能只靠它**。
- 性能：CPU 推理 12–37ms 量级（官方 AWS c7g 12.6ms、c8g 15.2ms；第三方重导出实测 36.3ms mean / 51.4ms p95）。
- 输入契约：16kHz 单声道 PCM，**取最近 8 秒的整段 turn 音频**（超出从头截），输出一个概率，>0.5 表示"说完了"。
- 官方用法与本设计一致：与轻量 VAD 配合，**只在静音期**运行；判定未完成又有新语音时，**重跑整段**（而不是只跑新增片段）。
- 训练集含 `orpheus_endfiller_1` / `orpheus_midfiller_1`（句尾/句中 filler）→ 对"话说一半"这类半句有直接信号，这是纯能量 VAD 与文本规则都拿不到的。

### 3. 新增端口（agent 持端口，desktop 注入实现）

```ts
interface TurnEndpointJudge {
  /** 返回 0..1 的"这轮说完了"概率；策略与阈值属于 agent 侧，不属于引擎。 */
  judge(pcm: Float32Array, sampleRate: number): Promise<number>;
}
```

端口返回概率而不是布尔：阈值、连续性、最长等待都属于 agent 侧策略，引擎不得内建。

### 4. 整轮缓冲与提交时序

- VAD 分段**照旧**（含 4.5s 强切与 pre-roll），但**不再逐段转写**。turn 层按采样区间并集拼接 VAD 段：用 `AudioSegment.startSample/endSample` 做区间合并，消除 pre-roll 与 1 帧 overlap 的重复（`VAD_CHUNK_OVERLAP_SAMPLES`），保证每个样本只出现一次。
- 整轮缓冲上限 `TURN_BUFFER_MAX_MS = 30_000`（16k 单声道 int16 约 960KB，可忽略）。上限存在的唯一理由是"真人独白"要有兜底。
- 提交时序：

```
VAD speech-ended（静音闭合）→ 向 judge 询问整段缓冲
   ├─ P ≥ TURN_ENDPOINT_THRESHOLD（初值 0.5）→ 产出一个"完整轮次"
   │      → 整轮一次性转写（一次解码）→ 文本进入 settle/规则层 → 提交
   └─ P < 阈值 → 判定为句中停顿：不提交、不转写，缓冲继续累积
          （新语音到来 → 继续累积；下一个停顿再判一次，按官方建议重跑整段）
缓冲超 30s → 强制产出一轮（可能切在半句，属罕见退化，需记录触发率）
```

- 由此每轮转写次数从"每 4.5s 一次"降为"每轮一次"，算力反而下降。
- 静音闭合窗可从 500ms 调到约 300ms（早点问 judge、降低延迟）：**闭合窗此后只决定"何时去问"，不再直接决定提交**；轮内误切率不再是关键指标（段退化为缓冲分片）。此项需在实施时与 [VAD turn-end 闭合窗修复记录](../../implemented/bug-fix/2026-10-21-vad-turn-end-close-window.md) 的 500ms 取舍一起复核。
- 端点判定通过后仍需经过 settle 与内容过滤层（后者见独立 Note）；本提案不改变那两层的职责，只把它们的输入从"碎段"换成"整轮"。

### 5. 依赖与资源

- **不引入 `onnxruntime-node`**：该原生二进制方案已在 [面试语音 VAD 选型](2026-10-20-interview-vad-silero-runtime.md) 中被否决（解压约 301MB、per-平台 ABI、退出崩溃、esbuild/asar 配套负债）。沿用该 Note 记录的 ORT-WASM 路线（与 Silero 后备同一条路径）：`onnxruntime-web` WASM 后端。
- 权重：`pipecat-ai/smart-turn-v3` 官方 int8 ONNX，随包分发；来源（固定 revision）、URL 与 SHA-256 锁进 `apps/desktop/native/asr-resources.json` 同款清单，准备脚本负责下载校验；许可原文随包保留。
- 前端：官方导出以 Whisper log-mel 为输入，需在 TS 侧实现该前端（约数十行、确定性算法）。备选是第三方"audio-in"重导出（前端已入图、喂 PCM 即可），但属第三方再分发，须单独审许可与来源。**先做尖刀**：实现的前端与官方权重是否对得上（用官方测试集比对输出概率），对不上则不进入仓库。
- 许可边界：BSD-2-Clause 允许商用与再分发，但必须随包保留许可原文与模型出处（与 rime/TEN VAD 的资源治理同款纪律）。

### 6. 失败语义

- 资源缺失 / 校验失败 / 权重加载失败 → **显式失败**（与 TEN VAD 同级），不得伪装成"判定未完成"导致无限等待。
- 推理期异常（NaN、超时、非有限值）→ 退回"固定窗口"语义（即当前 settle 行为）并记录一次**可观测的降级状态**；UI 需能显示"端点判定已降级"。降级不改变其它链路行为。
- 同一约定沿用 [面试语音识别管线与客户端 VAD 选型](2026-10-16-interview-asr-pipeline-and-vad.md) 的硬约束：识别链路的问题不允许靠"当作没发生"消化。

### 7. 明确不做

- 不做流式 partial 出字（本提案只在真端点产出文本；边说边出字属另一项体验决策，见"曾考虑的替代方案"中的保留项）。
- 不引入标点模型，也**不以标点作为句界依据**：现役 Paraformer 不输出标点，而端点本质是韵律/停顿问题。
- 不换 ASR 引擎：转写输入形态与引擎解耦，引擎选型单独决策（见替代方案）。
- 不做"该不该应答 AI"的判定：那是应答层的语义决策，不属于端点层。

## 模块边界

- `apps/agent/src/interview/turns/endpoint/`：纯领域模块，持有整轮缓冲、判定调用策略、轮次产出；不依赖 Electron / React / Node 平台 API；judge 只经端口注入，模块内不出现模型名、文件路径或推理框架。
- `apps/agent/src/interview/transcription/local/`：新增"整轮音频"输入形态（扩展现有 `RecognizerSource` 端口的输入，而不是新开端口），保持"引擎可替换"的既有边界。
- `apps/agent/src/worker/host.ts`：把 VAD 段与停顿事件接到 endpoint gate，把产出的整轮文本接到既有 settle 与内容过滤层；线协议不新增事件。
- `apps/desktop/src/main/interview/`：judge 组合根（ORT-WASM 加载、权重加载、mel 前端），失败显式报错；资源路径与校验属 desktop 职责，agent 不感知路径。
- `packages/shared` / `packages/ui`：零接口变更（除非 UI 需要展示端点判定降级状态）。

## 影响表面

- 用户消息的**产出时机**变化：从"utterance 结束 + 1s settle"变为"判定为真实端点后"；延迟构成从固定 1s 变为 judge 判定（约 40ms）+ 一次整轮解码。
- 用户消息的**文本质量**变化：整轮一次解码 → 段间不再丢上下文，当前"语音不对"的直接成因消失。
- `transcript-event` 节奏变化：从逐 VAD 段变为每轮一次 → desktop 投影与 UI 需复核（候选：保留段级事件并增加轮次标识，或直接以轮次为单位投影）。
- 内存：每会话多保留 ≤30s 音频（约 1MB）。
- 安装包：+8MB 权重 + ORT-WASM 运行时（体积待实测）。
- 算力：转写次数显著下降；judge 每次约 40ms，且只在停顿后触发。
- 事件语义：`turn-committed` 仍是"一个可提交轮次"；实施后需同步更新已实施的 [candidate 轮次 settle 合并](../../implemented/feature/2026-10-22-candidate-turn-settle-merging.md) 中"长 utterance 合并覆盖不足"等表述，避免两份 Note 互相矛盾。

## 曾考虑的替代方案

- **只调大 `VAD_MAX_CHUNK_MS`（4.5s → 15/30s）**：舍弃作为主方案。它不提供"何时发"的判据（仍靠静音赌），只是把切点变少；且逐段转写的零上下文问题依旧存在。仅采纳其上限数值思想到整轮缓冲上限。
- **用标点挑句子（引入 ct-punc 标点模型，或换带原生标点的引擎）**：舍弃作为本提案的句界依据。现役 Paraformer 不输出标点；引入标点模型要加资源与依赖；更要紧的是标点是文本侧代理，判不出"说完了"这种韵律事实。引擎若换到带标点的模型，再单独评估标点作为**辅助**信号。
- **滚动窗口解码 + 局部一致性（LocalAgreement）增量提交**：保留为后续可选。它能实现"边说边出字"，但需要反复重解码与前缀一致性比较，复杂度与算力都高于本提案；本提案先把"发对"做对，出字体验另议。
- **用 LLM 判定"说完了吗"**：舍弃。端点判定必须快（停顿后立刻决定），LLM 往返 1–2s 会把固定 1s 换成不可控的 1–2s，且要额外 token。语义层的"该不该答"才适合 LLM（见内容过滤 Note）。
- **用 smart-turn 取代 TEN VAD**：舍弃。职责不同：VAD 判"有声/无声"且要抗噪、要快，judge 判"说完没说完"；官方用法本身也是与轻量 VAD 配合。两者叠加不是二选一。
- **换 ASR 引擎到 Qwen3-ASR-0.6B（sherpa int8）或 Nemotron 3.5 streaming**：不纳入本提案，但方向不冲突——本提案的转写输入形态与引擎无关。引擎切换会牵动体积、延迟、许可与打包，属独立决策，应在 `examples/vad-asr-eval` 对拍后单独开 Note（见 [VAD/ASR 评测 harness 记录](../../implemented/process/2026-10-21-vad-asr-eval-harness.md)），而不是搭车进本提案。
- **维持现状（4.5s 强切 + 逐段转写 + 1s settle）**：舍弃。已实施 Note 记录的实测（轮内误切 19.77%、逐段解码零上下文）说明它只是把碎句从"上屏"挪到"识别质量"，用户侧的"语音不对"与"不知道何时发"都还在。

## 验收标准

- 可观察结果：一次自然停顿后，若判定为真实端点，则该轮音频**只解码一次**并产出**一条**消息；句中换气不产生新消息、也不触发转写；换气后继续说话时两段内容合成一条完整消息；同一轮内不出现重复文本或半句。
- 自动化验证：judge 端口用假实现注入（概率可控）——覆盖"高概率提交 / 低概率继续等 / 新语音后重跑整段 / 30s 上限强制产出 / judge 抛错时降级为固定窗口且状态可观测"；整轮拼接按采样区间去重（pre-roll 与 1 帧 overlap 不重复计入）；整轮音频长度与样本数一致；`transcript-event` 节奏与 `turn-committed` 语义与 Note 一致；worker 集成测试覆盖"停顿→判定→整轮转写→一条消息"的完整路径。
- 需要的实机验证：Windows loopback + 带标注的中文面试样本，记录 ①句中切断率（基线 19.77%）②端点延迟 P50/P95（基线含 1s settle）③非语义短轮误发率 ④judge 误切/漏切（以人工标注的"说完了"为准）⑤30s 强制产出触发率 ⑥整轮解码相对逐段解码的 CER 变化（应下降）。未完成不迁 `implemented/`。

## 风险

- **中文适配未验证**：官方中文准确率 88.57% 是通用语料上的数字，面试场景（远场麦、正式语气、中英夹杂）分布不同；阈值 0.5 与闭合窗 300ms 都是初值，必须用自有样本重标。
- **短段不可靠**：官方基准里 <1s 段 F1 67%、漏切 20%——"嗯"这类短促附和音的判定会不准，必须由内容过滤层兜底，不能只靠 judge。
- **ORT-WASM 路线是本 Note 的主要不确定性**：前端在 TS 侧实现（Whisper log-mel），与官方权重的数值一致性需要尖刀验证；不一致则要换第三方 audio-in 重导出（需审许可与来源）。若两条路都失败，本提案退回"固定窗口 + 规则层"并归档。
- **30s 强制产出仍是硬切**：真人独白（连续讲话超 30s）会切在半句，触发率需观测；这是比现状（每 4.5s 必切）好一个量级的退化，不是零退化。
- **turn 内不出字**：真端点前用户看不到文本，长回答的体感延迟仍等于说话时长（比现状好，因为不再等 utterance-end + 1s，但改善有限）。若这是主要痛点，应单独评估"投机解码草稿"或流式引擎，而不是在本提案里塞进来。
- **事件节奏变化波及投影层**：`transcript-event` 从逐段变逐轮，desktop/renderer 的消费方需要复核，避免出现"文本消失"或"重复上屏"。
- **与已实施 Note 的表述冲突**：settle Note 记录的"长段独立成段""合并覆盖不足"在本提案实施后不再成立，实施时必须同步改写那份已实施 Note。
- **许可与分发**：BSD-2-Clause 可商用，但必须保留许可原文与出处；ORT-WASM 的分发形态（wasm 二进制 + 许可）需与现有 `rime` / TEN VAD 资源治理保持同一纪律。

## 验证证据

- smart-turn 官方事实（2026-10-22 核对）：`pipecat-ai/smart-turn-v3` 模型卡与 `github.com/pipecat-ai/smart-turn`：Whisper Tiny 主干 + 线性分类头、约 8M 参数、8MB int8 / 32MB fp32 ONNX、BSD-2-Clause、23 语种含中文、16kHz 单声道、最多 8 秒输入、输出"turn complete"概率、官方用法为"VAD 报静音后对整段 turn 音频判定，若期间又有语音则重跑整段"；官方 v3.0 基准（31,527 样本、23 语）中中文准确率 88.57%、precision 0.857、recall 0.933、FPR 4.76%、FNR 6.67%，短句集 `chirp3_3_short` F1 66.7%/FNR 20.2%。
- 性能事实（2026-10-22 核对）：官方博客公布 CPU 推理 AWS c7a.2xlarge 12.6ms、c8g.2xlarge 15.2ms、Modal 6 核 17.7ms；Pipecat Cloud 实测约 65ms；第三方重导出（含内嵌前端）实测 36.3ms mean / 51.4ms p95（Apple M5 Pro，int8 11.1MB）。
- 我们的现役事实（仓内 Note）：Paraformer-zh-small int8 RTF 0.0128–0.0308、5.6s→80ms / 8.1s→98ms、12 句 61.1s 批量解码共 1881ms（[本地内置 ASR 路线 Note](2026-10-21-local-asr-paraformer-small.md)）；38 轮样本 EOT 召回 89.47%、F1 73.91%、轮内误切 19.77%、检测延迟 P50/P95 508/992ms（[VAD turn-end 闭合窗修复记录](../../implemented/bug-fix/2026-10-21-vad-turn-end-close-window.md)）；连续 68s 音频被切成 24 段（[VAD/ASR 评测 harness 记录](../../implemented/process/2026-10-21-vad-asr-eval-harness.md)）。**一次性 30s 输入未实测**，是本提案必须先做的尖刀之一。
- 依赖结论沿用（2026-10-20 核对）：`onnxruntime-node` 解包约 301MB、per-平台 ABI 与退出崩溃风险，已在 [面试语音 VAD 选型 Note](2026-10-20-interview-vad-silero-runtime.md) 中否决；ORT-WASM 路线（`onnxruntime-web`，开发机 node_modules 约 145MB，分发只带 wasm）已被该 Note 记为允许的后备路径。
- 参考实现（不作为代码来源，仅取事实）：`pipecat-ai/smart-turn` 的 `predict_endpoint` 输入契约、"短音频不适用"的说明；natively-cluely-ai-assistant 的"本地 VAD 停顿 + 端点确认"分层（其 `LICENSE` 为 source-available/非商业，不作为可移植实现来源，见 [面试语音识别管线 Note](2026-10-16-interview-asr-pipeline-and-vad.md)）。
- 提案阶段无 judge 成品、无整轮转写实现、无实机数据；本 Note 的所有阈值均为初值，不得在实施前当作"已验证参数"引用。
