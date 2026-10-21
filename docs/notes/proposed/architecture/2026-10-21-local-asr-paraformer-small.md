# Note：本地内置 ASR 路线与 Paraformer-zh-small int8 首选

状态：提案

## 问题

[面试语音识别管线与客户端 VAD 选型](2026-10-16-interview-asr-pipeline-and-vad.md) 的首轮 ASR 是内网自部署 Qwen3-ASR-0.6B HTTP 批式服务，仅用于受控开发验证，不能作为面向普通用户的产品路径（无鉴权内网地址、部署与可用性不受控）。[面试模式持续监听与回答建议](../feature/2026-10-12-live-interview-assistant.md) 因此把 ASR 定为云端订阅，并在替代方案中否决了"让普通用户本机运行 Whisper/Ollama"。用户（产品方向最终决定者）本轮明确要求先验证本地内置模型路线，并指定 `paraformer-zh-small int8` 为首批候选。

需要回答：轻量本地内置模型是否可与现有批式 VAD 管线、Agent 运行时边界、桌面打包形态相容；若能，首批落地什么模型、按什么顺序验证。

## 涉及范围

- 代码/模块：`apps/agent/src/interview/transcription/` 新增本地 provider adapter（segment 输入形态）；`apps/desktop` 预编译资源准备脚本与组合根（模型路径注入，与 rime 资源同构）；esbuild 打包约束（native addon external + asarUnpack）。
- 进程/合规表面：推理驻留 Agent utility process；音频不再出设备（本地路径不发起网络请求）；安装包体积增加约 80MB；"关于/许可"页面需保留模型出处（FunASR 许可 v1.1 条件）。
- 产品口径修订：10-12 Note 的本地否决对象是"让用户本机跑 Ollama/大 Whisper"（体积、性能、启动可用性不可控，且不得成为静默回退）；本方案是"随安装包分发的轻量内置模型"且作为**显式 provider 选型**而非静默降级，属于不同性质。实施时需在 10-12 Note 补一条边界修订记录，不得静默改写原否决条目。
- 相关 Note：[面试语音识别管线与客户端 VAD 选型](2026-10-16-interview-asr-pipeline-and-vad.md)、[面试语音运行时模块边界与并行开发契约](2026-10-19-interview-runtime-module-boundaries.md)、[TEN VAD 选型与打包回归](2026-10-20-interview-vad-silero-runtime.md)；预编译资源纪律见根目录 `AGENTS.md` 内置输入法资源节。

## 提案

### 硬约束：本地与云端必须可无缝切换

- 产品口径：云端订阅 ASR 是终态主线，本地内置只是"产品快速可用"的推进手段，不是终点；后续云端网关（AVPzien / DashScope realtime 等）接入时，本地路径要么成为低配/离线档位，要么按实际口径退役或并存——该取舍将来另行决策，不锚定于本 Note。
- 切换保证来自既有契约而非新增层：所有 provider（Qwen HTTP / 本地 Paraformer / 未来 realtime WS）实现同一个 provider-neutral 会话接口（10-19 Note `interview/transcription/` 边界），coordinator 读 provider capabilities（输入形态 segment/stream、语言、限制声明）选 provider；turn assembler 与回复层不得感知模型来源。
- 本地 adapter 必须通过与 Qwen HTTP adapter 同组 contract tests（同一 fixture AudioSegment、同一错误归一化断言、同一 cancel/迟到/停止语义）；不得为本地路径新增契约类型或旁路。
- `packages/shared` 与 UI 表面不得出现"模型是本地还是云端"的判断逻辑；若产品需要显式标注 provider 档位，走独立的产品层状态字段，不在转录事件里混入来源字段。

### 首批选型

- **模型**：`sherpa-onnx-paraformer-zh-small-2024-03-09` 的 `model.int8.onnx`（约 80MB）+ `tokens.txt`（75KB）+ `am.mvn`（11KB）。语种为中英混合（中文为主，vocab 8358），非自回归 CTC 引导注意力离线模型，靠本地 VAD 分段喂整段，产出 chunk-final 文本。
- **运行时**：`sherpa-onnx-node`（node-addon-api，N-API，全平台 prebuilt：Windows x64 / macOS x64+arm64 / Linux x64+arm64；无需编译器/Python/CMake；Apache-2.0；npm 周下载约 64 万）。离线识别 API 对 Paraformer / SenseVoice 两类模型一致，后续换模型不重写 adapter。
- **加载位置**：Agent utility process 内加载 native addon（N-API 抽象层理论上跨 Node/Electron ABI 稳定），模型文件路径由 desktop 组合根经端口注入；Agent 不写死资源路径。模型属于预编译资源：不进 Git、来源 URL 与 SHA-256 锁定、`asr:prepare` 前置脚本校验，同 rime / TEN VAD 资源纪律。
- **语义**：输入为完整 `AudioSegment`（`boundaryKind` 保留在事件里，adapter 不再需要区分——批式模型整段一次推理）；输出 `TranscriptEvent` 仅 `chunk-final` 与 `error`，无 partial。资格要求与 10-16 Note"批式分段语义"一致；不能对外宣称 realtime progress。
- **失败语义**：模型加载失败 / 推理失败一律显式 error（稳定错误码 + 可重试性），不得假装空文本、不得静默降级到云端。

### 实施顺序

1. **尖刀 spike（未触碰仓库、临时目录）**：临时目录 `npm i sherpa-onnx-node`，下载 paraformer-zh-small int8，Node 版现有跑批式识别测试 WAV；测首段延迟/RTF/内存；随后按 TEN VAD 尖刀 precedent 在 Electron utility process 验证 native addon 加载与 esbuild 打包形态。spike 未达成则本 Note 转 rejected。
2. **`LocalParaformerAdapter`**：input WAV 编码、内存策略、超时/取消、错误归一化；contract tests 用 fixture AudioSegment、假模块注入（真模型不进单测）。
3. **desktop 资源准备**：`asr:prepare`、SHA-256 清单（仿 `rime-resources.json`）、打包 external/unpack 配置、macOS 动态库定位处理。
4. **精度与延迟校准**（对应 10-20 Note 阶段 8 的实机环节）：Windows + macOS 真实面试样本测 CER、短音频 P95、内存；未达标不迁 implemented。
5. HTTP adapter（内网 Qwen）与云端订阅路径仍保留为产品方向，排序后移，不弃用。

## 曾考虑的替代方案

- **SenseVoice-Small int8（~228MB）**：第三方实测强（clean CER 2.27%、短音频 P95 163ms @ Ryzen 7 5800H、峰值内存 355MB），五语种且自带 ITN；但安装包增量约为 Paraformer-small 的 3 倍。同类 offline recognizer API 一致，列为第二候选——Paraformer-small 通链路后可无痛升级，届时再评体积取舍。2026-10-21 本仓库链路复测（`examples/vad-asr-eval/harness`，对话口径）：SenseVoice CER 8.02%、max 解码 275ms，均劣于 paraformer-zh-small int8（3.09%、85ms）——官方口径之外的第三方实测未在本机复现，第二候选地位进一步降级，保持 paraformer-zh-small int8 为默认。
- **Transformers.js + onnxruntime-node（natively-cluely 路线，worker_threads）**：模型目录/类型生态最丰富，但 ESM-only 包需动态 import 绕走、依赖 HF Hub 移动目标（revision 未锁）、模型管理面复杂（15+ 模型清单、下载/删除/预加载 IPC 全套）；natively 在 Windows 上的公开实跑证据也仅覆盖 macOS。作为打包/版本/资源管理的确定性成本高于 sherpa-onnx-node；舍弃。
- **真流式模型（streaming zipformer/paraformer）**：能出 partial，但双语 zipformer 2023 版精度低于离线大模型，且当前 `TranscriptEvent` 没有真实 partial 消费者（turn assembler/reply 契约在批式语义上已冻结）；留作未来 realtime 门控候选，不作为首批。
- **GGUF FunASR 二进制（llama-funasr-sensevoice/paraformer）**：CLI 二进制意味着第三种进程形态与 per-platform 产物审查，且许可以 funasr.com 发行版为准未经核对；舍弃。
- **whisper.cpp / Whisper tiny int8**：中文准确率显著劣于 FunASR 系（上游自称 ~3× CER 差距，此为自评数据），且自回归解码在 CPU 上慢于非自回归模型；舍弃。
- **不做云端、只做本地内置**：本地模型有设备性能差异与精度天花板，云端订阅仍是产品主线之一（10-18 契约）；本 Note 只是把首轮验证目标改为本地，不取消云端路径。

## 模块边界

- `apps/agent/src/interview/transcription/local/`：本地 adapter 只消费 `AudioSegment` 端口并产出 `TranscriptEvent`；不感知 VAD、turn、reply、IPC 或 Electron；真模型加载经注入端口（单测用假模块，不上传真模型）。
- `apps/desktop`：模型资源准备、SHA-256 校验、组合根注入模型路径与 addon 加载所需 env（macOS 动态库定位）；不实现识别逻辑。
- `packages/shared`：零变更（不出现模型的文件名、shutil 配置或 provider 内部类型）。

## 风险

- **精度风险（最高）**：paraformer-zh-small 是 vocab 15k 内的小模型，实际中英文面试场景准确率未实证（第三方对比数据来自同架构大模型）；必须以阶段 4 spike + 阶段 8 实机校准为准，未达标候选迁移至 SenseVoice int8 或云端路径。
- **Electron utility process 加载 native addon 未实证（Node 直载已通过）**：2026-10-21 spike 已证实 Node 环境 `npm i` 即装即用、模型加载与批量转写全通；剩余风险收窄到 Electron utility process 内的 N-API 加载、esbuild external、asarUnpack、macOS dylib 定位四项，仍须实机验证后才可进入实施阶段第 2 步。
- **模型文件最小集收窄**：spike 证实 `am.mvn` 缺失不影响识别——发布资源清单只需 `model.int8.onnx` + `tokens.txt` 两个文件，资源准备脚本按此最小集校验。
- **第三方转换模型来源**：paraformer-zh-small 的 ONNX 由社区转换（modelscope crazyant），非 FunASR 官方发布物；必须锁定具体 release URL + SHA-256，且在产品关于页保留出处。
- **许可约束**：FunASR v1.1 允许商用并要求注明出处、保留模型名；修订协议会"自动生效"，需定期复核（风险与 Agora 附加条款同等级记录）。
- **内存常驻**：模型 session 装载策略（会话期间常驻 vs 按需加载）影响内存与首段延迟；spike 数据出来后单独决定，不在本 Note 预定。
- 10-12 Note 否决条目的修订若不作记录，未来读者会看到矛盾的 ASR 决定史；实施时必须以条目内修订标记同步，不得静默覆盖。

## 验收标准

- spike 能在临时目录跑通：批式识别测试 WAV → 中文文本；记录 RTF、首段延迟、峰值内存（Node 版本、机器配置）。
- Electron utility process 实机加载三项验证（addon 加载、esbuild 打包、动态库定位）未完成前，不得声称裸加层加载已验证。
- `LocalParaformerAdapter` contract tests：fixture AudioSegment → chunk-final；失败含显式 error；停止/取消清理模型会话；不同 sessionId 隔离。
- 发布包不含模型时不启动 adapter 并给出可排查报错；模型损坏/SHA 不匹配报错同样 fail-closed。
- 阶段 8 校准数据（CER、P5/P95、首建延迟）未达标不迁 implemented，云端 HTTP 路径保留为可用备选。

## 验证证据

- 2026-10-21 完整链路延迟实测（真实 TEN VAD 预编译件 + repo 真实 `SpeechActivityDetector`/`VadSegmenter`/`InterviewVadPipeline` 组合 + paraformer int8；AISHELL-1 S0002 十句 + 句间 850ms 静音拼成 68s 连续流、449 个 100ms 帧喂入；临时测试文件跑完即删）：VAD 纯处理 1.08s → VAD RTF = 0.0158（超实时约 63 倍，VAD 不构成瓶颈）；段数 24（含原 8.5s 长句被强切与 utterance-end 正常闭合）。句末文本就绪延迟 ≈ 静音闭合窗（占位 700ms）+ 段识别：small int8 每段 15–185ms（最长就绪 ≈ 861ms）、large int8 同段 40–654ms（4.5s 段就绪 ≈ 1.25s，印证"大模型整段解码是延迟大头"）；识别文本与官方参考基本一致。另见 sherpa 离线识别对 <0.3s 超短段会抛 Reshape 异常并返回空文本——接 adapter 实施时须跳过过短段（或由调用方过滤），避免无谓解码与噪声报错。
- 2026-10-21 批式识别准确率对照（AISHELL-1 S0002 12 句 / 61.1s，直接喂 recognizer，无 VAD；去标点归一后按字符比对）：paraformer-zh-small int8 CER 1.74%、RTF 0.0308（解码共 1881ms/61.1s）；paraformer-zh-large int8 CER 2.33%、RTF 0.0473（2890ms）。12 句样本不足以定结论，但该批次 small 不输 large，且"large 一定更准"的直觉被否——候选切换前必须用更大的官方测试集复核（不下整包，先用带标注子集）。对照报告与逐句配对落盘于本地 spike 目录 `eval/report.md`（不入仓库）。
- 2026-10-21 尖刀 spike 本机实测（临时目录，Node v24.16.0，win32，未触碰仓库；脚本仅 100 行 CJS）：`sherpa-onnx-node` 1.13.8 `npm i` 即装即用（含 Windows x64 DLL 自动定位）；同时下载 HF `model.int8.onnx`（81,828,675 bytes）+ `tokens.txt`（75,352 bytes），`am.mvn` 下载失败但模型仍可加载转写——Paraformer offline 配置只需 model + tokens 两文件。`OfflineRecognizer` 模型加载 1.6s（冷启动一次性）；批量转写官方 test_wavs 四段：5.6s 中文段 80ms、5.2s 中文段 67ms、8.1s 中英混段 98ms、7.9s 方言段 97ms，**RTF = 0.0128（约 78 倍速）**；转写文本中文/中英混合全对，方言样本可出文本；进程 RSS 约 208MB。该数据落在 Note"验收标准"spike 条的达标区间，验证目标（批式识别测试 WAV → 中文文本 + RTF/首段延迟/峰值内存）已满足；Electron utility process 加载与 esbuild 打包形态仍是独立验证项。
- 2026-10-21 模型与运行时核对：`csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09`（HF）含 `model.int8.onnx` 81.8MB、`tokens.txt` 75.4KB、`am.mvn` 11.2KB，来源为 modelscope `crazyant/speech_paraformer_asr_nat-zh-cn-16k-common-vocab8358-onnx`；sherpa 官方 docs 提供下载命令与 8k/16k 输入解码范例。
- 2026-10-21 `sherpa-onnx-node` npm 页与 k2-fsa 安装文档核对：node-addon-api prebuilt（Node ≥16），支持 Linux x64/arm64、macOS x64/arm64、Windows x64；Windows 无需库路径环境变量，macOS/Linux 需 `DYLD_/LD_LIBRARY_PATH`；版本 1.13.8，Apache-2.0，周下载约 64 万。
- 2026-10-21 FunASR Model Open Source License v1.1 原文（modelscope/FunASR `MODEL_LICENSE`）核对：2.1 允许自由使用/复制/修改/分享；2.2 要求注明出处与作者信息并保留模型名称；无竞争限制条款（对比 TEN VAD 的 Agora 附加条款更为宽松）。
- 2026-10-21 同架构 CPU 实测第三方凭证（VoiceFlow model-lab 2026-07-18，具有与其他模型同机对比的说明力）：SenseVoice-Small int8 clean CER 2.27%、short-P95 163ms、峰值内存 355MB（Ryzen 7 5800H 8C16T，sherpa-onnx 1.13.3，六线程）；Qwen3-ASR-0.6B int8 P95 1298ms、Whisper large-v3-turbo int8 P95 3217ms 同机被拒。该数据用于性能区间判断，不是 Paraformer-small 的精度证据。
- 参照项目 natively-cluely-ai-assistant（2026-10-21 本地源码检查）：本地 ASR 用 transformers.js + onnxruntime-node 1.22 在 Electron main worker_threads 常驻，模型运行时从 HF Hub 拉取至 `<userData>/whisper-models`，Nemotron 真流式仅该模型；无 sherpa-onnx/SenseVoice 集成先例可抄，本方案在打包与资源管理上遵循我们自己的 rime/TEN VAD 同构资源纪律，不复制其 HF Hub 动态下载模式。`packages/shared` 不出现模型文件名、sherpa 配置或 provider 内部类型。
