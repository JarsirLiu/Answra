# Note：VAD 评测以 turn 判定与响应延迟为主

状态：已实施

## 问题

`eot-bench` 把 VAD 分段、Paraformer 转录和 CER 放进一个汇总。CER 同时受 ASR 能力和分段影响，容易被误读成 VAD 指标。原 turn 统计用片段音频结束时间与标注静音起点做最近邻匹配，无法表示系统何时真正产出 turn-end；只报告 EOT 召回和 hold 误切，也没有汇总端点精确率与 F1。此外，`stagedSegments` 返回内部数组引用，随后 stop-time `flush` 会把片段追加到这份引用里，造成离线终止片段混入在线检测数据。

产品需要及时识别面试官/会议对方的发言轮次并开始回答，因此评测重点应是自然端点检测的准确性与延迟，以及 ASR 解码耗时。回答生成尚未接入这条 harness，不应把评测称为完整的端到端回答延迟。

## 涉及范围

- 代码/模块：`examples/vad-asr-eval/eot-bench-eval.test.ts`、`eot-bench-metrics.ts`、`README.md`；Agent 对外评测入口 `apps/agent/src/interview/evaluation.ts`
- UI/进程/协议/持久化表面：仅离线评测与 CSV 输出；不改变产品运行时。
- 相关 Note：[本地 Paraformer adapter](../feature/2026-10-21-local-paraformer-adapter.md)

## 决定

- turn-end 只统计音频帧送入时由 VAD 自然产出的 `utterance-end`；先复制暂存快照，再 stop，明确排除 stop-time `flush` 的段。
- 使用样本标注的 `silenceSpans` 区分轮次末尾静音和轮内停顿。报告 EOT 精确率、召回率、F1、轮内误切数/比例，以及命中 EOT 的音频时间轴检测延迟 P50/P95。
- 分帧记录实际观察到 segment 的输入采样位置，延迟从轮次末尾标注静音起点算到观察位置；这是样本时间轴延迟，不是离线跑分的墙钟延迟。
- 保留真实 ASR adapter 解码；只对实际产出 `chunk-final` 的段计算解码 P50/P95，短段跳过单独计数。仅在末段产出转录时报告「EOT 检测延迟 + 最后一段解码」估算。回答模型生成时间不在范围内。
- CER 保留为逐轮辅助诊断，不作为 VAD 质量判断依据。
- 逐轮 CSV 并列保留参考原句与真实链路识别句，另提供人工审阅列（是否应回复、语义是否完整、是否可输入文本模型、备注）。不输出数据集参考回答，也不生成产品答案。
- 评测放在仓库根目录 `examples/vad-asr-eval`，作为独立可选 workspace 包；跨包通过 `@answra/agent/evaluation` 明确导出评测所需链路，不使用相对深导入。
- Agent 已有 turn 状态和 worker 帧类型，但尚无聚合转写并提交 turn 的运行时，也没有 AI 消息派发策略。不可将单个 VAD `utterance-end` 直接当作 AI 发送命令；后续需要独立 turn 聚合/决策阶段，策略和主 Agent/子 Agent 协作方式另行设计。

## 曾考虑的替代方案

- **继续用整句 CER 做主指标：** 舍弃。它把 ASR 错误和切段损失混在一起，不能回答 turn 是否及时、准确。
- **只跑 VAD 而移除 ASR：** 舍弃。这样能隔离 VAD 计算开销，却无法观察回答前的转录解码延迟；当前评测保留 ASR，并把其延迟与 VAD 端点延迟分开呈现。
- **把 stop/flush 当作自然端点：** 舍弃。文件结束可以强制收段，但在线会话中只有静音检测闭合才证明系统及时判断了 turn。

## 后果与防回退

- `eot-bench-summary.csv` 的首要字段是 turn 准确性、端点延迟、ASR 解码延迟和 VAD RTF；CER 放在诊断字段。
- 端点延迟按帧观察位置计算，受 100ms 帧粒度和样本标注精度影响。报告中不能将其描述为实机墙钟响应延迟。
- `stagedSegments` 是有界内部数组视图；评测必须在每帧后收集新段，避免 32 段暂存上限淘汰历史段，也要避免 stop-time flush 追加改变在线统计集合。
- 完整产品响应还包括回答模型首 token/首段时间；该链路未在本评测中测量，后续应另加真实采集到首个回答输出的测量。

## 验收标准

- 自动化验证：纯指标测试覆盖自然 EOT 命中、轮内误切、漏检及延迟计算；运行 agent 测试与类型检查。
- 需要的实机验证：Windows loopback 真实会议/面试音频下的在线 EOT 墙钟延迟及首个回答输出延迟；离线 eot-bench 不能替代。

## 测试范围

- eot-bench 只测 turn 端点、轮内停顿误切、音频时间轴端点延迟、ASR 段解码时间和 VAD RTF。
- CER 是辅助 ASR/分段诊断字段，不设置 CER 验收线，也不据此判断 VAD turn 准确性。
- 逐轮 CSV 必须并列保留标注原句和链路识别句，并提供是否应回复、语义是否完整、是否可输入文本模型、备注四个人工字段；不得输出数据集参考回复或生成回答。
- 指标单测覆盖命中延迟、轮内误切、漏检和容差外误报；真实 eot-bench 使用固定 manifest 样本与模型，离线运行且不进入常规 CI。

## 验证

- `pnpm --filter @answra/vad-asr-eval exec vitest run eot-bench-metrics.test.ts`：3 项指标测试通过；`pnpm --filter @answra/vad-asr-eval eval:eot`：真实链路 1 项评测通过，生成 38 轮逐轮 CSV。
- 最新真实样本基线（38 轮）：EOT 精确率 66.67%、召回率 63.16%、F1 64.86%；检测延迟 P50/P95 为 688/1196ms；实际 ASR 解码 P50/P95 为 92/159ms；端点 + 末段解码估算覆盖 22 轮（57.89%），P50/P95 为 777/1246ms；VAD RTF 0.02295。CER 30.36% 仅作诊断。
- 人工抽查：`zh__2258`、`zh__2260` 的主要问题和约束基本完整，可作为回复上下文；`zh__2256` 人名被错识；`zh__2257` 末尾“来午饭我试一下”语义不可靠；`zh__2262` 电话号码与标注不符且 EOT 漏检；`zh__2270`、`zh__2272` 没有识别文本。因此这批样本不能整体判为可输入，逐轮 CSV 保留空白人工审阅列供进一步标注。
- `pnpm typecheck`、`pnpm test`、`pnpm notes:check`、`pnpm architecture:check` 通过；本次评测目录 targeted Biome 检查通过。`pnpm verify` 在 lint 阶段被工作区已有的 `apps/agent/src/interview/vad/segmenter.ts` 格式差异阻断，该文件未纳入本次提交。
