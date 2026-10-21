# VAD + ASR 评测

这个可选工具位于仓库根目录 `examples/vad-asr-eval`，查看真实样本经过产品音频链路后的转录与 turn-end 行为。它调用真实 `InterviewAudioIngress`、TEN VAD、`InterviewVadPipeline` 和 `LocalParaformerAdapter`，不会生成回答，也不进入 `pnpm verify`。

## 用法

```bash
# 下载真实中文轮次样本和 Paraformer 模型
pnpm --filter @answra/vad-asr-eval eval:eot:fetch --count 40
pnpm --filter @answra/vad-asr-eval eval:asr:fetch

# 运行 turn + 转录评测
pnpm --filter @answra/vad-asr-eval eval:eot

# 可选：运行 AISHELL 模型诊断
pnpm --filter @answra/vad-asr-eval eval:asr
```

资产 URL、字节数和 SHA-256 以 manifest 为唯一事实来源。模型、样本数据落在 `models/`、`data/`，产物落在 `out/`；均不提交 Git。

## 人工审阅

逐轮 `out/eot-bench-results.csv` 并列展示 `reference_text`（样本标注原句）和 `recognized_text`（真实链路输出）。请看识别句是否保留了原句语义、是否达到可输入文本模型的标准。人工列为 `review_should_reply`、`review_semantic_complete`、`review_model_input_acceptable`、`review_notes`。CSV 不包含数据集参考回答，也不生成模型回答。

## 延迟与 turn 指标

`out/eot-bench-summary.csv` 报告 turn-end 精确率、召回率、F1、轮内停顿误切、EOT 检测延迟、ASR 解码延迟和 VAD RTF。EOT 延迟按 100ms 帧推进的音频时间轴计算，不是离线跑分的墙钟时间。turn-ready 估算只在检测到 EOT 且末段产生转录时统计，并报告覆盖率；不包含文本模型生成。

CER 保留为 ASR/切段诊断，不用于判定是否通过。人工审阅结合原句、识别句和 turn 行为作最终判断。
