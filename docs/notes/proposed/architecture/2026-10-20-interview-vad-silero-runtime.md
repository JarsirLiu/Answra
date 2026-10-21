# Note：面试语音 VAD 选型与 Agent 内适配器（阶段 3）

状态：提案

## 问题

[面试运行时模块边界](2026-10-19-interview-runtime-module-boundaries.md)规定的阶段 1–2 已交付（PCM 采集底座、`ingress` 校验），阶段 3 需要 VAD 检测器与分段器的具体实现。[`VadDetector`/`AudioSegmenter` 契约已冻结]（`apps/agent/src/interview/contracts.ts:82-85,103-107`），当前 `worker/host.ts` 的 `onFrame` 是空转，帧在 ingress 校验后无人消费。[批式 ASR 路线](2026-10-16-interview-asr-pipeline-and-vad.md)要求本地 VAD 承担切段正确性：句首 pre-roll、hangover 闭合、低能量强切、失败显式报错。需要决定：检测器用什么模型/引擎、放在哪一层、模型资源如何治理。

## 涉及范围

- 代码/模块：`apps/agent/src/interview/vad/`（新增）、`apps/agent/src/worker/host.ts`（帧接线）、`apps/desktop/native/ten-vad-resources.json`（资源清单与准备脚本入口）。
- UI/进程/协议/持久化表面：Agent utility process 内部实现变更；desktop/renderer/shared/通道契约不变；音频与检测结果仍只在内存，不落盘。
- 相关 Note：[面试语音识别管线与客户端 VAD 选型](2026-10-16-interview-asr-pipeline-and-vad.md)、[面试运行时模块边界](2026-10-19-interview-runtime-module-boundaries.md)、[面试模式持续监听与回答建议](../feature/2026-10-12-live-interview-assistant.md)。

## 提案

- **检测器引擎：TEN VAD（`TEN-framework/ten-vad`，Apache-2.0 附附加条款），官方 emscripten WASM 构建**。仓库提供 `lib/Web/ten_vad.js`（ES6 胶水）+ `ten_vad.wasm`（约 278KB）+ 手维护 `ten_vad.d.ts`；hop 160/256 样本（10/16ms），`_ten_vad_process` 同步逐窗返回概率与二值 flag，阈值 0.5。Node 下加载方式：ESM `import()` 胶水 + 显式传 `wasmBinary`（构建为 `ENVIRONMENT='web,worker'` 且 `NO_FILESYSTEM=1`，默认路径解析不可用）；**不引 onnxruntime、零原生二进制依赖**。
- **后备：Silero VAD v6 系列（MIT），ONNX 导出 + `onnxruntime-web` WASM 后端**。约 1.2MB / 309K 参数、流式 LSTM 状态、32ms 窗。`VadDetector` 端口不变可无损替换。若 Windows 下 TEN WASM 接入受阻或实测不达标，切此路径。
- **运行时不依赖 ricky0123 生态**：`@ricky0123/vad-node` 0.0.3 停更约两年、仅 `NonRealTimeVAD`、锁 ORT 1.14；`@ricky0123/vad` 老且仅浏览器；实时 API 走自适配。
- **适配器形态**：新增 `apps/agent/src/interview/vad/`——`tenVadDetector.ts`（`VadDetector` 实现：帧内样本进 hop 缓冲 → 同步 `_ten_vad_process` → 按 flag/概率迟滞产出 `SpeechActivityEvent`）、`segmenter.ts`（`AudioSegmenter` 实现）、`config.ts`（默认阈值常量）、`vadModuleLoader` 端口（注入 wasm glue 模块与 wasmBinary，不硬编码资源路径）。检测器内部聚合 hop 级概率（hop 256 样本=16ms，一帧 1600 样本≈6.25 hop，尾窗留到下一帧）。
- **分段器行为（阈值默认值待实机校准）**：本地静音闭合窗当前为 500ms（原占位 700ms，离线 38 轮 turn-end 评测后调整；接受较高轮内误切以换取更高 EOT 召回和更低延迟，详见 [VAD 自然 turn-end 闭合过慢](../../implemented/bug-fix/2026-10-21-vad-turn-end-close-window.md)）；静音达到闭合窗后闭合 `utterance-end`；段长 ≥ 4.5s 在最低 RMS 处强切 `continuation` 并保留 1 帧重叠；stop 时 flush 尾段。speech-started 事件携带 300ms pre-roll 环形缓冲，保证字头不丢。
- **失败语义（沿用 10-16 Note 硬约束）**：VAD 加载失败（资源缺失/校验不过）或推理失败（NaN、非法返回）必须显式置 `runtime-failed`，不得装作静音或静默丢帧。
- **资源治理**：`ten_vad.wasm` 为二进制，不提交 Git；来源（固定 release tag/commit）、URL 与 SHA-256 固定在清单文件（沿用 `apps/desktop/native/rime-resources.json` 的模式），准备脚本负责落盘校验；检测器只经 `vadModuleLoader` 注入消费，不感知下载与路径。
- **许可边界（防回退）**：TEN VAD 采用 Apache-2.0 + Agora 附加条款——不得以与 Agora 产品竞争的方式部署，也不得使第三方能借此开发/部署应用；Answra 只为自身与直接终端用户部署，当前兼容。**产品若演化为向第三方开发者开放的接入平台，或与 Agora RTC/语音服务同业，必须重新评审许可，否则不得升级分发。**NOTICES 中 LPCNet 派生代码（BSD-2/3-Clause）已在二进制内携带，保持随包声明不删除。
- **串声防线继承既有设计**：候选人（麦克风）通道的转录仅作上下文、不触发回答；窗外串声（speaker bleed）声学上是真语音，任何 VAD 都会放行（参考项目实测记录），因此 onset 判定的额外防线仍是后续阶段的连续帧/迟滞与 turn-settle，不在 VAD 层解决。
- **不做什么**：ASR 请求队列/HTTP adapter（阶段 4）、turn 聚合（阶段 5）、回答生成（阶段 6）、组合根与实机验证（阶段 7–8）、realtime 门控、UI 展示。

## 当前状态、目标与下一步

- **当前状态**：TEN VAD → `SpeechActivityDetector` → `VadSegmenter` → 本地 ASR 的离线评测链路已可运行。自然端点静音窗已从 700ms 调至 500ms；同一 38 轮样本的 EOT 召回为 89.47%、F1 为 73.91%、检测延迟 P50/P95 为 508/992ms，但轮内误切为 17/86（19.77%）。500ms 是偏实时响应的暂定值，尚未用 Windows loopback 真实面试/会议音频校准。完整取舍与结果见 [VAD turn-end 修复记录](../../implemented/bug-fix/2026-10-21-vad-turn-end-close-window.md) 和 [真实样本评测记录](../../implemented/testing/2026-10-21-vad-turn-latency-evaluation.md)。
- **当前缺口**：`speech-ended` 会关闭 utterance 段并触发转录，但它不是可靠的业务 turn 结束信号；短停顿会让一句回答拆成多个段。当前尚无 turn 聚合/settle 层决定何时把转录文本作为完整输入交给模型，也没有将候选人音频排除在触发源之外的 turn 级策略。
- **目标**：保持端点快速发现，同时把短暂停顿期间可能继续到达的转录段合并为可用文本；只有 turn 决策层确认文本可交付后，才交给后续 Agent 消费。端点事件应是候选边界，不能直接触发模型回复。
- **下一步**：阶段 5 单独定义并实现 turn 聚合层。先基于现有 `SpeechActivityEvent`、`AudioSegment` 与 `chunk-final` 的真实来源定义状态、失效边界和可观察输出；覆盖连续短停顿续说、多个 utterance 合并、迟到转录、长时间无续语音及 stop flush 的测试；用真实样本人工审查最终聚合文本是否语义完整、是否达到可输入模型的标准，并测量从自然端点到 turn-ready 的延迟。随后以 Windows loopback 复核短停顿误切和墙钟延迟，再决定 500ms 是否保留或调整。
- **暂不决策**：主 Agent 是否即时通知子 Agent、暂存多段后批量发送，以及是否生成回答，不属于本次端点修复；应在 turn 聚合结果与真实延迟/文本审查可用后另行确定。

## 模块边界

- `apps/agent/src/interview/vad/`：纯领域模块，不依赖 Electron/React/node 本地平台 API；TEN WASM 胶水为 ES6 静态资源，经 `vadModuleLoader` 注入后仅内存持有，资源路径与下载属于 desktop/准备脚本职责。
- `apps/agent/src/worker/host.ts`：本阶段把 ingress 校验后的帧接入 VAD → segmenter，输出暂存于会话内暂存（供后续阶段消费），音频 credit 回执路径不变。
- `apps/desktop` / `packages/ui` / `packages/shared`：零接口变更；desktop 后续仅在阶段 7 组合根参与资源路径注入。
- 检测器与分段器实现按规模预算拆小文件、函数 ≤ 约 40 行；契约文件不再新增导出面。

## 曾考虑的替代方案

- **`@ricky0123/vad-node`（本会话早前提过）**：查证后该包两年未更新、仅提供 `NonRealTimeVAD`（非实时）且锁 `onnxruntime-node@^1.14.0`，不符合流式帧需求；舍弃并用本方案。
- **`@ricky0123/vad-web`（浏览器实时 API）**：与仓库架构冲突——VAD 归属 Agent 运行时（10-19 Note 阶段 3 边界），且该包本身就跑 ORT 的 WASM，自适配收益大于跟随其停更生态；舍弃。
- **`onnxruntime-node`（原生二进制）**：可靠性风险与体积代价（解压约 301MB、per-平台 ABI 锁、退出崩溃、esbuild/asar 配套负债）显著高于收益；任一路径下养护成本都远超收益，当前不采用；仅当两条 WASM 路径均实测失败时重新评估。
- **手写能量 VAD（RMS + 迟滞）**：对字头截断/键盘声/风扇噪声的鲁棒性弱，且没有维护良好的纯 JS 能量 VAD 库——相当于自造轮子；舍弃（保留自适应 RMS 仅作分段器强切点选择，不作主检测器）。
- **WebRTC VAD（C/GMM 时代方案）**：在噪声环境对 Silero 明显劣势，生产项目实际经验是系统音频通道仅敢用 RMS 通道兜底；无维护良好的 Node 绑定；舍弃。
- **TEN VAD 的 ONNX 路线（ preprocess 在模型外）**：官方 ONNX 导出的预处理（LPCNet 派生特征提取）在模型之外，接入需把整套特征代码移植 TS 重跑，工程量与出错面大于直接使用官方 `ten_vad.js`+`ten_vad.wasm`；若未来需要脱离 emscripten 运行时再评估。
- **Pyannote segmentation-3.0**：离线滑窗（10s 窗口）高精度 VAD，非流式形态；留待未来离线批式/复用评估；当前不用。
- **Picovoice Cobra**：商业闭源、需要 AccessKey 与生产许可；与仓库开源栈契约矛盾；舍弃。
- **不经 VAD 固定间隔上传（10-16 Note 已否决）**：频繁切断单词、重复计费；不重复。

## 验收标准

- 可观察结果：音频帧进入 Agent 后能逐 source 产出 `SpeechActivityEvent` 与 `AudioSegment`；停会话时尾段 flush；推理失败显式 `runtime-failed`。
- 自动化验证：合成 PCM（正弦爆发/噪声底/静音）单测涵盖 speech-started/speech-ended 顺序、utteranceId、atSample、confidence；pre-roll 保留字头；短停顿不拆、长语音低能量强切、会话 `reset` 隔离、stop flush；资源缺失/非法帧注入显式失败；检测器以注入的 mock 模块单测事件逻辑，`vadModuleLoader` 注入路径单独单测；worker/host 集成测试（ingress → VAD → segmenter 通链、credit 路径不回归）。
- 需要的实机验证：阶段 8——Windows 真实 loopback + 带标注的中英文面试样本，校准阈值（短停顿/强切尺寸/hangover/pre-roll），输出过早拆分率、漏拆率、串声误触发率；未完成不迁 `implemented/`。

## 风险

- 默认阈值为占位值，未经真实音频校准前不准宣称可靠分割；错误分段会直接让临时建议的时机与整体质量变差。
- ~~TEN WASM 在 esbuild bundle 到 Electron utility process 后的加载与时序需打包侧回归确认（尖刀测试已验证 Node ESM 直载）~~——已完成（2026-10-21）：尖刀测试只覆盖过 `file://` 导入形态，bundle 探针在 data: URL 导入下暴露 glue 顶层 `new URL(..., import.meta.url)` 崩溃，已修复并固化回归（见 [TEN VAD glue 经 data: URL 导入时的 wasm 路径解析崩溃](../../implemented/bug-fix/2026-10-21-ten-vad-data-url-glue.md)）；Electron utility process 内的实机链路仍归阶段 7–8。失败按硬约束显式报错，不静默降级；若 TEN 路径被阻断，后备 Silero + ORT-WASM 路径需重建推理连接（一次性成本已在"曾考虑"记录）。
- TEN VAD 与 Silero 的输出签名不同（同步 flag/概率 vs 异步窗口概率）：适配器只面向 `VadDetector` 契约，替换实现时不得把任一引擎的窗假设硬编码为常量。
- Agora 附加许可条款是长期边界：商业化/开放接入形态变化时必须先重评许可（见提案节）。
- VAD 层错误边界只有两类路径：显式失败（正确）与兜底假装静音（不允许）——沿用 10-16 Note 的硬约束，不新增例外。
- `ten_vad.wasm` 属预编译资源：不进 Git、来源锁 tag、SHA-256 校验、准备脚本校验；若准备脚本不跑，适配器加载失败需给出可排查的明确报错。
- 强切修复后单 chunk 可携带至多 `VAD_MAX_CHUNK_MS + VAD_CHUNK_OVERLAP_SAMPLES` 的音频（切点偏早时旧尾巴随新 chunk 续传）；阶段 4 的 ASR 请求队列/计费上限须按该结果上界核对（见 [2026-10-21 VAD segmenter continuation hole](../../implemented/bug-fix/2026-10-21-vad-segmenter-continuation-hole.md)）。

## 验证证据

- 2026-10-20 在线核对：`pnpm view onnxruntime-node dist.unpackedSize` → 301,068,136 字节（约 301MB）；`pnpm view onnxruntime-web dist.unpackedSize` → 144,618,540 字节（约 145MB，仅开发机 node_modules，分发只需选用 wasm）；`silero_vad_v5.onnx` 官方仓库 2.22MB；`@ricky0123/vad-node` 0.0.3 最近发布约两年前且 README 标注"Non-realtime voice activity detection for node"，`@ricky0123/vad` npm 页标注已 deprecated。
- 2026-10-21 打包侧回归成立：本机补跑 `pnpm --filter @answra/desktop vad:prepare`（TEN VAD 2.1.2 / d68ab71c 落盘 `resources/vad`），新增常驻回归 `apps/desktop/test/tenVadBundle.test.ts` 以与 worker 产物相同的 esbuild 选项（CJS / node20.9）打包探针并执行"清单校验 → SHA-256 校验 → data: URL 导入 glue → WASM 实例化 → 静音 hop 判非语音"全链路通过；其间发现并修复 data: URL 崩溃缺陷（复盘见 [2026-10-21 TEN VAD glue data: URL defect](../../implemented/bug-fix/2026-10-21-ten-vad-data-url-glue.md)），CI 自此在 Test 前固定执行 `vad:prepare`。Electron utility process 实机运行仍归阶段 7–8。
- 2026-10-21 领域单测收口（阶段 3 遗留项第 2 项完成）：`apps/agent/test/interview/vad/` 新增 `tenVadEngine.test.ts`（7 条，假 glue 从原生侧视角锁 glue 注入选项/句柄生命周期/样本窗传输契约）、`segmenter.test.ts`（10 条：ring 预滚封顶、4.5s 最低 RMS 强切 + 1 帧 overlap 重放、可补裂口补零、超限撕裂 fail-closed、flush/reset、事件契约与非法事件序拒绝）、`pipeline.test.ts`（6 条：推理失败升级 `runtime-failed` 且 hop 恰好释放一次、暖机缓冲 16 帧上限、按序补发、共享引擎单次加载、暂存 32 条有界丢弃、逐源路由）。`@answra/agent` vitest 72/72 全绿。其间暴露并修复三个真缺陷：hop 样本从未写入 wasm 内存（[2026-10-21 TEN VAD hop sample copy](../../implemented/bug-fix/2026-10-21-ten-vad-hop-sample-copy.md)）、强切 chunk 挖洞丢音频（[2026-10-21 VAD segmenter continuation hole](../../implemented/bug-fix/2026-10-21-vad-segmenter-continuation-hole.md)）、teardown 先清空后挂回调导致 hop 泄漏（[2026-10-21 VAD pipeline teardown hop leak](../../implemented/bug-fix/2026-10-21-vad-pipeline-teardown-hop-leak.md)）。外部佐证：natively-cluely `vadProcessor.ts` 的 softCommit 尾部保留注释独立踩过"切段无连续性→转录丢首词"。
- Silero VAD v6 实况（后备路径依据，2026-10-20 搜索核证：soniqo.audio/vad 指南、paean-ai/silero-vad-swift README、github vadimatmurphy/vad-comparison）：约 1.2MB / 309K 参数、STFT+LSTM 流式、32ms 窗、CPU <1ms/窗、LSTM 状态显式可控、官方 MIT 模型。
- 提案阶段无 TEN 适配器成品与打包侧实测；既有证据只证明引擎可在 Node ESM 载入并达到实时充足速度、许可与体积边界清楚，不证明产品质量/实机可用性（归阶段 8）。
- WebRTC/Silero/Cobra 对比（picovoice.ai 2025-11 blog）：WebRTC VAD 常见 cutoff 显著高于 Silero；Silero 优势在噪声环境与持续维护。
- 参考项目 natively-cluely-ai-assistant（本地仓库，非实现来源）：`native-module/src/silence_suppression.rs` 系统音频全平台 `use_vad:false` + 600ms hangover、mic VAD 仅 macOS（`auto-answer-v3-progress.md:122-124`）、扬声器 bleed 通过任何 ML VAD 的记录（`auto-answer-v3-progress.md:803-804`）；其 LICENSE 为 source-available/非商业（见[管线 Note 证据](2026-10-16-interview-asr-pipeline-and-vad.md)：不作为可移植实现来源，商用复用需权利方书面许可）。
- TEN VAD 许可与体积（2026-10-20 raw 安装凭证）：`LICENSE` 原文 = Apache-2.0 + Agora 附加条款（禁竞争部署/禁使第三方开发部署应用；第三方派生代码 BSD-2/3-Clause 见 `NOTICES`）；lib/Web 产物 `ten_vad.js` + `ten_vad.wasm` 约 278KB，构建 flags（`ENVIRONMENT='web,worker'`、`NO_FILESYSTEM=1`、`MODULARIZE=1`、`EXPORT_ES6=1`、`EXPORT_NAME=createVADModule`）见 lib/Web/README.md。
- **TEN 接入尖刀测试（2026-10-20 本机 Node v24.18.0，临时目录，未触碰仓库）**：
  - 加载：ESM `import('ten_vad.js')` + `createVADModule({ wasmBinary })` 成功，零文本补丁（仓库自带 `examples/test_node.js` 需要 CJS 文本改写；ESM 直载不需要），引擎版本 `ten_vad_get_version()` = `2.1.2`。
  - 合成 6.00s 音频（2s 语音正弦/1s 噪声/2s 语音/1s 静音）：375 hop 全部处理成功，RTF≈0.0106；flag 转换发生在 2.00s 与 3.01s 区域，与内容边界吻合。
  - 真实语音 `examples/s0724-s0730.wav`（16kHz mono，7.63s）：RTF≈0.0093，出 5 段（0.48–2.22 / 2.29–3.78 / 4.82–7.15 三段实质语音 + 两段 <0.2s 短噪声 blip，后者将由最小语音时长过滤）。
  - 精确度/漏检声称（PR 曲线优于 Silero）来自上游自评测试集（testset 目录公开、`plot_pr_curves.py` 可复现）；自我百分位待阶段 8 用自有标注样本复核。
