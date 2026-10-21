# Note：VAD 自然 turn-end 闭合过慢

状态：已实施

## 问题

真实 eot-bench 中 `zh__2270` 和 `zh__2272` 都有明确语音与可识别转录，但音频结束前没有自然 `speech-ended`。当前静音闭合阈值为 700ms；这两条样本标注的尾静音分别约 550ms、627ms，在线端点因此漏检。stop flush 能回收转录段，但不能作为及时 turn-end 的证据。

## 涉及范围

- 代码/模块：`apps/agent/src/interview/vad/config.ts`、`speechDetector.ts`、`apps/agent/test/interview/vad/speechDetector.test.ts`、`examples/vad-asr-eval/eot-bench-eval.test.ts`
- UI/进程/协议/持久化表面：只改变自然端点触发时机；事件契约不变。
- 相关 Note：[VAD turn 延迟评测](../testing/2026-10-21-vad-turn-latency-evaluation.md)、[VAD 运行时提案](../../proposed/architecture/2026-10-20-interview-vad-silero-runtime.md)

## 根因

`SpeechActivityDetector` 只有累计至少 `VAD_CLOSE_SILENCE_MS` 个非语音 hop 才发 `speech-ended`。700ms 是校准前占位值；在两条短尾静音样本中阈值未达到，会话在自然端点到达前结束。

## 决定

- 将本地静音闭合窗从 700ms 调至 500ms。TEN Framework 的 Realtime 示例使用 `semantic_vad`，并配置 500ms silence duration；其 turn 判断含语义信号，不与本地 TEN VAD 的二值非语音累计完全等价。本地采用 500ms 是由当前数据集上的延迟/召回优先取舍决定，不是直接移植 TEN 的语义策略。
- 保留基于 TEN VAD 非语音判决累计时长的状态机、端点回溯时间戳和事件契约。
- 用真实 38 轮评测检查 EOT 召回、误切、检测延迟和 ASR 可用性。500ms 在本次样本上取得最高召回与 F1、最低延迟，并识别出 `zh__2270`、`zh__2272` 的自然端点；接受误切增加，等待 turn settle 消费者作候选端点判定。
- 自然 `speech-ended` 只标记语音段边界；它不是发送 AI 消息的命令。短停顿和业务发言策略仍由后续 turn 决策层处理。

## 修复

- `apps/agent/src/interview/vad/config.ts`：`VAD_CLOSE_SILENCE_MS` 从 700 调至 500。
- `apps/agent/test/interview/vad/speechDetector.test.ts`：锁定 496ms 仍不闭合、达到下一个 16ms VAD hop 后闭合；已有短停顿续说与新 utterance 测试继续覆盖事件顺序和 ID。

## 曾考虑的替代方案

- **600ms 闭合：** 舍弃。误切较低（8/86，9.30%），但召回仅 76.32%，未检出 `zh__2272`，F1 71.60%。
- **550ms 闭合：** 舍弃。召回 81.58%、P50 560ms，但误切 13/86（15.12%），F1 71.26%，没有 500ms 的快速性与召回收益。
- **520ms 闭合：** 舍弃。召回 86.84%，但误切 16/86（18.60%），且仍未检出 `zh__2272`。
- **700ms 原值：** 舍弃。F1 64.86%、召回 63.16%、P50 688ms，未能及时闭合短尾轮次。
- **stop flush 计为 turn-end：** 舍弃。会话结束时强制收段没有在线及时性证据，会污染 EOT 延迟评估。

## 后果与防回退

- 在同一 38 轮真实样本上的 500ms 结果：EOT 精确率 62.96%、召回率 89.47%、F1 73.91%；检测延迟 P50/P95 508/992ms；轮内误切 17/86（19.77%）；turn-ready 覆盖 31/38（81.58%），P50/P95 566/1009ms（按当前评测 CSV 四舍五入）。
- `zh__2270`、`zh__2272` 均自然命中；TEN VAD hop 分类和样本边界差异意味着名义静音时长不保证相同实测闭合时间。
- 500ms 是偏响应速度的本地阈值，不是经 Windows loopback 完成校准的普适最优值。短思考/句中停顿误切明显增加；固定样本评测锁定此取舍，后续 turn settle 应将 `speech-ended` 作为候选边界并可等待续语音更新，而非立即派发。
- 500ms 的 `speech-ended` 不直接触发 AI 派发；turn 聚合与主 Agent 的发送/攒批策略仍需独立设计。

## 验收标准

- 可观察结果：较原值减少自然 EOT 漏检并降低端点延迟；接受 500ms 方案较高的轮内误切，供后续 turn settle 消化。
- 自动化验证：speech detector 单测通过；真实固定样本评测产出新旧可比较指标。
- 需要的实机验证：Windows loopback 面试/会议音频下复核短停顿误切率与真实墙钟延迟。

## 风险

- 离线 eot-bench 不能覆盖实时采集、扬声器串声、房间噪声及人类思考停顿分布；上线前仍需实机验证。
- VAD 自然端点仅提供候选边界，AI 回复时机必须由独立 turn 决策策略控制。

## 验证

- `pnpm --filter @answra/agent test`：11 个文件、79 项通过；`pnpm --filter @answra/agent typecheck` 通过。
- `pnpm --filter @answra/vad-asr-eval eval:eot`：38 轮真实链路通过，产出上述 500ms 指标。
- 对照试跑 700/600/550/520/500ms：EOT F1 分别为 64.86/71.60/71.26/73.33/73.91%；轮内误切率分别为 5.81/9.30/15.12/18.60/19.77%。
