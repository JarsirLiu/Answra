# Note：本地 ASR 模型资源的准备流程与 Electron utility process 加载验证

状态：已实施

## 问题

[本地内置 ASR 路线与 Paraformer-zh-small int8 首选](../../proposed/architecture/2026-10-21-local-asr-paraformer-small.md) 的实施顺序第 3 步要求 desktop 侧完成资源准备：`asr:prepare` 脚本、SHA-256 清单（仿 `rime-resources.json`）、打包 external/unpack 配置与 macOS 动态库定位。落地前有三个必须先解决的问题：

1. 模型是 82MB 的大文件，来源在境内网络上长连接会被中途重置（`curl` 报 `Recv failure: Connection was reset`），首版按 TEN VAD 抄来的下载逻辑（失败即整份重来、无断点续传、partial 存在临时目录随进程退出被删）实际无法完成下载；
2. 模型来源、字节数与许可出处必须锁定，否则无法随安装包分发；
3. 提案列出的未决风险是"Electron utility process 内 native addon 加载未实证"（Node 直载已通过），这一项不落地就不能声称本地 ASR 可用。

## 涉及范围

- 代码/脚本：`apps/desktop/native/asr-resources.json`（新增，来源清单）、`apps/desktop/scripts/prepare-asr.mjs`（新增，下载与校验）、`apps/desktop/package.json`（新增 `asr:prepare` 脚本）、根 `.gitignore`（新增 `apps/desktop/.cache-asr/`、`apps/desktop/resources/asr/**`）。
- 产物：`apps/desktop/resources/asr/`（模型 `model.int8.onnx`、`tokens.txt`、`licenses/MODEL_LICENSE`、运行时 `manifest.json`），不进 Git。
- 相关 Note：[本地内置 ASR 路线与 Paraformer-zh-small int8 首选](../../proposed/architecture/2026-10-21-local-asr-paraformer-small.md)、[TEN VAD 选型与打包回归](../../proposed/architecture/2026-10-20-interview-vad-silero-runtime.md)、[LocalParaformerAdapter（阶段 2）](../feature/2026-10-21-local-paraformer-adapter.md)；预编译资源纪律见根目录 `AGENTS.md`。

## 决定

### 资源清单

`native/asr-resources.json` 锁定来源仓库、revision、许可、每个文件的 URL、字节数与 SHA-256：

- 模型：`csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09`，revision `63ddc3cd0f2810b68289a7b3876e62ef5d53d6df`（HF API 实测的仓库 commit），`model.int8.onnx` 81,828,675 bytes / `tokens.txt` 75,352 bytes；发布最小集只有这两个文件，`am.mvn` 不需要。
- 许可：`alibaba-damo-academy/FunASR` 的 `MODEL_LICENSE`（5,306 bytes）随包分发到 `licenses/`，FunASR v1.1 要求注明出处并保留模型名。
- 转换来源：该 ONNX 由 modelscope `crazyant/speech_paraformer_asr_nat-zh-cn-16k-common-vocab8358-onnx` 社区转换，不是 FunASR 官方发布物；清单内以 `conversionSource` 字段显式记录，更新模型时必须同步复核。

### 下载流程

- 脚本 `prepare-asr.mjs`（`pnpm --filter @answra/desktop asr:prepare`）按清单下载 → 逐文件 SHA-256 校验 → 落 `resources/asr/`（含只保留 `name`/`sha256` 的运行时 `manifest.json`），任一文件哈希不符即报错退出（fail-closed，不留半份资源）。
- 断点续传：partial 落在 `.cache-asr/<name>.part`（跨进程保留），失败重试用 `curl -C -` 从已有字节继续，最多 30 次；服务端不支持区间时（curl 退出码 33）清掉 partial 重下。缓存文件哈希命中即跳过下载。
- 启动时清理上次中断遗留的 `prepare-*` staging 目录。
- 模型与缓存不进 Git（`.gitignore`），只提交来源清单。

### 与打包、组合根的边界

打包配置（`extraResources` 携带 `resources/asr`、`asarUnpack` 规则、`sherpa-onnx-node` 依赖引入）与 desktop 组合根的模型路径注入**不与本 Note 同批落地**：这些只有在 desktop 真正 `require` 该 addon、即产品链路存在消费者时才有意义，提前加 `extraResources` 只会让安装包凭空多 82MB。它们随接线批次（provider 接入面试运行时）一并提交，届时的打包形态验证要求一并覆盖。

> 2026-10-21 更新：桌面侧依赖、打包配置与组合根胶水已先于宿主接线独立落地（用户裁定先装配引擎的批次顺序），由 `asrBundle.test.ts` 打包回归先消费，胶水无死代码；详见 [本地 ASR 引擎桌面装配](../feature/2026-10-21-asr-paraformer-engine-assembly.md)。真实 `dist:win` 打包与 macOS `DYLD_LIBRARY_PATH` 仍是遗留验证项。

## 曾考虑的替代方案

- **直接从 huggingface.co 下载：** 官方源在本机网络下长连接失败率更高；改用 hf-mirror 源并以 SHA-256 锁定内容（哈希绑定字节，镜像本身不构成信任前提）。源清单的 revision 字段仍指向上游 commit，来源可追溯。
- **把模型提交进 Git：** 82MB 二进制违反仓库纪律（AGENTS.md 预编译资源纪律），且每次 clone 都要拉取。
- **只在评测 workspace 保留模型、不做 desktop 资源准备：** 评测产物不随包分发，产品的许可出处与 fail-closed 校验无处落地；评测与产品必须共用同一份锁定清单。
- **不做断点续传、失败即整份重来：** 本机网络下 82MB 传输平均每十几 MB 被重置，整份重来实际拿不到完整文件。
- **把 `asr:prepare` 固定进 CI：** 当前没有任何 CI 回归消费该资源（真实模型不在单测里），82MB 下载换不到回归价值；等出现常驻打包回归再评估。
- **不随包分发许可原文、只在文档里写出处：** FunASR v1.1 要求保留模型名并注明出处，许可原文必须进包。

## 流程变化

- 新增开发期命令 `pnpm --filter @answra/desktop asr:prepare`：按清单下载并校验本地 ASR 模型资源，落 `apps/desktop/resources/asr/`。与既有 `ime:prepare`、`vad:prepare` 并列，属于同一条"预编译资源不进 Git、发布前本地准备"的纪律。
- 资源获取路径：`.cache-asr/` 缓存（哈希命中即跳过下载）→ `resources/asr/` 正式资源（`prepare-*` staging 目录仅用于原子替换，启动时清理上次中断遗留项）。
- 断点续传：partial 保留在 `.cache-asr/<name>.part`，失败重试从断点继续（最多 30 次，指数退避），进程被中断也不丢已下载进度。
- 打包与运行时的接线在宿主注入批次前止于桌面装配：`resources/asr` 目前被验证、评测与打包回归（`asrBundle.test.ts`）消费，产品链路（utility process 内 provider 装配与 transcript 事件）随宿主接线批次落地并单独留证。

## 后果与防回退

**后果**

- `apps/desktop/resources/asr/` 出现 82MB 本地文件是正常状态；`asr:prepare` 未跑过就缺资源属于预期失败路径。
- 打包与组合根接线仍待落地：在此之前，desktop 运行时不会加载本地模型，本 Note 的验证范围止于"资源可准备 + utility process 可加载"。
- macOS 动态库定位（`DYLD_LIBRARY_PATH`）与 `asarUnpack` 规则未在本机验证，需要 macOS 与真实打包批次各自补证据。

**防回退约束**

- 更新模型文件必须同时改 `native/asr-resources.json` 的 URL、revision、字节数与 SHA-256 并本地重算哈希，不得只替换文件。
- 运行时加载必须先按 `resources/asr/manifest.json` 校验 SHA-256，校验不过直接失败，不回落其它模型。
- 随包分发必须保留 `licenses/MODEL_LICENSE`，并在产品关于页标注模型名与出处。
- 引入 `sherpa-onnx-node` 的接线批次必须同时补 `asarUnpack` 规则（`onnxruntime.dll` 等 DLL 不会像 `.node` 一样被自动解包）与 macOS `DYLD_LIBRARY_PATH` 处理，并各自留实机证据。
- `OfflineRecognizer` 配置形状固定为 `modelConfig` 内含 `tokens`/`numThreads`/`provider`/`debug`；写顶层会在运行期报 `tokens: '' does not exist`。

## 验证

- 2026-10-21 `pnpm --filter @answra/desktop asr:prepare` 实跑通过：三个文件下载完成并逐个 SHA-256 校验通过，落盘 `resources/asr/`（`model.int8.onnx` 81,828,675 bytes、`tokens.txt` 75,352 bytes、`licenses/MODEL_LICENSE` 5,306 bytes、运行时 `manifest.json` 743 bytes）；二次运行走缓存命中，秒级完成。
- 2026-10-21 断点续传实证：未开代理时每次长连接在约 13MB 处被重置（`curl: (56) Recv failure`），加入 `-C -` 续传后单次运行内可推进；partial 落在 `.cache-asr/` 使进程被中断也不丢进度。资源源已确认支持字节区间（`Accept-Ranges: bytes`，`X-Linked-Size` 与清单字节数一致）。
- 2026-10-21 Electron utility process 实机验证（Windows 11，本机 `apps/desktop/node_modules/electron` 29.4.6，尖刀脚本跑完即删）：utility process 内 `require("sherpa-onnx-node")` 成功加载 native addon（平台二进制来自可选依赖包 `sherpa-onnx-win-x64`，含 `sherpa-onnx.node` 与 `onnxruntime.dll`），加载 `resources/asr` 模型后整段解码一段 4.325s 中文语音（TTS 合成，句为"请问如何在本地运行语音识别模型"），输出文本"请问如何在本地运行语音识别模型"（无标点），与输入一致。同一脚本以 esbuild（`platform: node` / `format: cjs` / `target: node20.9` / `external: ["sherpa-onnx-node"]`，与 `build-electron.mjs` 的 worker 产物同参）打包成 bundle 后再由 utility process 加载，同样通过——即"external 保留运行时 require + 运行时从 node_modules 解析"这条真实打包形态成立。
- 2026-10-21 配置形状实证：`OfflineRecognizer` 的 `tokens`/`numThreads`/`provider`/`debug` 必须写在 `modelConfig` 内，写在顶层会报 `tokens: '' does not exist` 并创建失败。评测 harness（`examples/vad-asr-eval/chain-eval.test.ts`）用的正是 `modelConfig` 内形状，形状正确；desktop 组合根实现时必须照此形状，Top-level 写法会在运行期才炸。
