# VAD + ASR 评测脚手架

针对 `proposed/architecture/2026-10-21-local-asr-paraformer-small.md` 的本地 ASR 候选做端到端评测：真实 `InterviewAudioIngress`（未信任输入校验 + 连续性追踪）→ 真实 TEN VAD 预编译件 → repo 真实检测器/分段器（`InterviewVadPipeline`）→ 生产 `LocalParaformerAdapter`（引擎经端口注入为真实 sherpa-onnx addon + manifest 固定的 int8 模型，与产品同一条代码路径）逐段离线解码。产出逐段 CSV 与逐模型汇总 CSV。由 `ANSWRA_ASR_EVAL_RUN=1` 门控，不进常规 CI（`pnpm verify` 下恒 skip）。

评测只支持 manifest `asr=paraformer` 的模型（small/large）。sensevoice 的直调对比数据已记档于 Note，不再走 adapter 评测。默认只跑 small：单进程、模型顺序加载、逐段同步解码，工具自身不做任何并发，避免占用整机。

## 用法

```bash
# 1. 下载模型与对照集（默认 small + sense；加 large 用 --models small sense large）
pnpm --filter @answra/agent eval:asr:fetch
# 2. 跑评测，输出 CSV
pnpm --filter @answra/agent eval:asr

# 一键（两步合一）
pnpm --filter @answra/agent eval:asr:one
```

- 模型与 AISHELL 子集落在 `models/`、`data/`（gitignore）；CSV 产物在 `out/`。
- 资产 URL + 字节数 + SHA-256 以 `assets.manifest.json` 为唯一事实来源，SHA 不匹配强制重下。
- 对照数据：AISHELL-1（Apache-2.0）单说话人 `S0002.tar.gz` + 官方逐句转写，10 句拼成带 850ms 静音间隔的连续流，喂 100ms 帧走真实链路，逐段解码后与参考文本按"去标点归一化 + 字级编辑距离"算 CER。

## CSV 口径

`out/results.csv`（逐段行）：`model_id, clip_id, boundary, seg_dur_s, decode_ms, cer_pct, ref_text, hyp_text`。

`out/summary.csv`（逐模型行）：分段数、字数/错字/CER、mean/p95/max 解码、闭合窗（占位 `VAD_CLOSE_SILENCE_MS`）与 max 解码相加的"句末就绪近似"、流时长（s）、VAD 总耗时与 VAD RTF。

注意：Paraformer 输出不含标点；SenseVoice 经 `useInverseTextNormalization` 开 ITN 自带标点，CER 比对前两侧统一做去标点/去标签归一化。闭合窗阈值仍是占位参数，`max_ready_ms` 是近似值。

## 两种 CER 口径

- `seg_cer_pct`：逐强切段 vs 整句参考。强切天然切断首尾字，且 <0.3s 超短段（sherpa 会异常输出空文本）被计入，因此该列只用于诊断切损，不能当作模型准确率。
- `utter_cer_pct`：同一句话的全部有效段（≥0.3s）按时间序合并 hyp 后对照整句参考——对话场景"这句话说完后的可读文本"口径，以此为准。`short_skipped` 计数超短尾巴段（强切产生的空/残缺片段，产品层应丢弃或并入后重整）。
