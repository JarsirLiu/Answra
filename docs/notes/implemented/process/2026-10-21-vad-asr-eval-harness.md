# Note：VAD + ASR 评测脚手架（examples/vad-asr-eval）

状态：已实施

## 问题

本地 ASR 候选评测（批式准确率对照、真实 VAD 链路端到端延迟）此前完全落在系统临时目录里的 spike 脚本：换机即失效、SHA 与数据来源没有可追溯载体、逐句"参考文本 vs 识别文本"与延迟数据没有固定产物格式。同时 sherpa-onnx-node 能否支撑仓库工程形态（typecheck / 门禁 / 依赖归属）只验证到"局部 require"，没有走一遍完整仓库流程。

## 涉及范围

- `apps/agent/examples/vad-asr-eval/`（新增）：`assets.manifest.json`、`fetch-assets.mjs`、`run-eval.mjs`、`chain-eval.test.ts`、`README.md`。
- `apps/agent` `devDependencies`：新增 `sherpa-onnx-node@1.13.8`（评测运行需要；后续 adapter 实施时的正式依赖归属由其 Note 决定，届时再迁移）。
- `.gitignore`：评测的模型、数据集与产出目录不进 Git。
- 不涉及 `packages/shared`、`@answra/ui`、`@answra/desktop` 及任何产品行为/IPC/契约。

## 决定

1. 评测资产（模型 + 数据）固定来源落进 `assets.manifest.json`：hf-mirror 直链 + 文件级 SHA-256 + 字节数。模型只用 csukuangfj 转换 channel（paraformer-zh-small-2024-03-09、paraformer-zh-2024-03-09）的 int8 onnx 与 tokens；当前只固定已实测下载并复算过 SHA 的条目，SenseVoice 等"三方同台"候选在新资源落地+复算 SHA 之前不进清单。
2. `fetch-assets.mjs` 一键下载：默认 small；模型别名（small/large）走宽松 arg 解析（pnpm 可能吃掉逗号或 flag）；文件存在且 SHA 匹配则跳过，SHA 不匹配必须重下；node fetch 失败退到 PowerShell 下载再统一 SHA 校验。AISHELL-1 只取 `data_aishell/transcript/aishell_transcript_v0.8.txt` + 单说话人 `data_aishell/wav/S0002.tar.gz`，tar 包内自带 `train/S0002/` 目录层。
3. `chain-eval.test.ts`（vitest）由 `ANSWRA_ASR_EVAL_RUN=1` 门控，缺省恒 skip：真实 TEN VAD 预编译件（`apps/desktop/resources/vad`）→ repo 真实 `SpeechActivityDetector`/`VadSegmenter`/`InterviewVadPipeline` 组合 → 逐段多模型离线解码；与官方参考文本按"去标点归一化 + 字级编辑距离"计算 CER。产物固定为 `out/results.csv`（逐段行）与 `out/summary.csv`（逐模型汇总：分段数、CER、mean/p95/max 解码、句末就绪近似、VAD RTF）。
4. `run-eval.mjs` 设环境变量后经 `pnpm --filter @answra/agent test -- vad-asr-eval` 拉起 vitest，评测与日常测试同 runner、同 typecheck、同 lint。
5. 仓库入口：`@answra/agent` 提供 `eval:asr:fetch`、`eval:asr`、`eval:asr:one` 脚本。评测指标只覆盖"分段 + 识别 + 延迟"；真实投递策略（何时把文本交给 LLM、何时触发回复）不属于评测范围，由阶段 4 消费者 Note 单独落定（本轮明确：回复单位 = utterance，`continuation` 强切只并入暂存，不单独触发）。

## 流程变化

- 评测走 agent 包内脚本入口而非临时目录；资产"URL+SHA+字节"唯一事实来源是 `assets.manifest.json`，更新资产必须先本机重下并复算 SHA 再改清单。
- 新增评测运行门控模式：`pnpm verify` 与 CI 下评测恒 skip，不产生模型/数据下载噪声；评测结果作为 Note 证据时须注明运行环境与数据集范围。

## 曾考虑的替代方案

- **只维护临时目录 spike**：丢失可复现性与资产追溯；评测口径（SHA、阈值占位、CER 归一）无法沉淀。舍弃。
- **评测并入 `@answra/desktop`**：评测第一目标是 agent 运行时链路（VAD+segmenter），desktop 只是资源宿主；且 desktop 不应积累非产品工具代码。舍弃，sherpa 依赖的正式迁移等 adapter Note。
- **并入 `packages/ui` 测试/CI 关口**：这不是用户行为回归测试，模型下载与执行噪声会拖慢门禁；保持按需手动运行。舍弃。
- **评测数据进 CI 固定资产池**：涉及发布资产流程，超出本次范围；仅保证本机可一键复现。舍弃。

## 后果与防回退

- `sherpa-onnx-node` 进入 agent devDeps（锁 1.13.8）：评测与产品实现若后续替换模型加载实现需同步改脚手架；depends 指令锁定。
- 评测目录下 `models/`、`data/`、`out/` 全部 gitignore；模型供应商 URL/SHA 变更必须先在本机重下并复算 SHA，再更新 manifest，禁止只换文件不动清单（large 模型曾因仓库猜错被 SHA 拒收，证明该闸有效）。
- 评测脚本不写任何产品路径；`apps/desktop/resources/vad` 预编译件缺失时报错并提示 `vad:prepare`，不得绕行自备 wasm。
- 评测脚本不进入自动 CI 关口（env 门控）；传给下游取证时必须说明数据集范围（当前 10 句 AISHELL S0002，非全集）。

## 验证

- 2026-10-21 `fetch-assets.mjs` 实跑按序完成：small 与临时 spike 期间实测 SHA 一致（`3ef6c193…b229ec`）；早期错误下载的 243,371,218 bytes `model.int8.onnx`（仓库选错为 `2023-09-14`）被 SHA 校验拒收并强制重下，large 最终由正确仓库 `2024-03-09` 落地为 227,330,205 bytes（SHA `90bc0303…584c`）；AISHELL transcript（10,091,431 bytes）与 `S0002.tar.gz`（36,455,331 bytes）解包出 365 个 S0002 wav。
- 2026-10-21 `pnpm --filter @answra/agent test`：72 passed、评测 spec 在无 `ANSWRA_ASR_EVAL_RUN` 时为 skip；`typecheck`、biome 全绿，评测无门禁噪声；`pnpm notes:check` 通过。
- 评测 CSV 复跑策略按用户决定暂停全量实跑（10 句 × small/large 已在临时 spike 中得到同口径数据：VAD RTF 0.0158、small 段级就绪 ≈0.86s、large ≈1.25s）；脚手架对需重新评测的情形保持一键可复现，结果回填本文或现有方案 Note。
