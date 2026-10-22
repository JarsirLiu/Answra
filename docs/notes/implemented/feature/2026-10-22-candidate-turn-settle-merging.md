# Note：candidate 轮次 settle 合并与最小有效轮过滤

状态：已实施

## 问题

面试对话里一个 VAD utterance 直接等于一条用户消息（`apps/agent/src/worker/host.ts` 在 committed turn 到达时立刻 `appendUserMessage`）。说话人的换气、迟疑产生的 >`VAD_CLOSE_SILENCE_MS`(500ms) 停顿会被 TEN VAD 正确闭合，但ɉ合成的结果是同一句话被切成多条碎消息；每次整段 Paraformer 解码各自独立、段间零上下文，识别质量随碎片变差；"嗯/哦"这类附和音也从麦克风通道成独立消息上屏。用户实测截图中连续出现"你是谁/嗯/即将改动/提交改动"式碎句——先澄清：这不是 VAD 切错的 bug，是"utterance 即消息"的投影粒度错误。

## 涉及范围

- 代码/模块：`apps/agent/src/interview/turns/settler.ts`（新增）、`apps/agent/src/worker/host.ts`（接线）、`apps/agent/test/interview/turns/settler.test.ts` 与 `apps/agent/test/worker/host.test.ts`。
- 相关 Note：[面试实时语音人工试用闭环](../feature/2026-10-22-live-audio-test-loop.md)、[面试 ASR 管线与 VAD 提案](../../proposed/architecture/2026-10-16-interview-asr-pipeline-and-vad.md)。

## 影响表面

- 用户消息的产出粒度变化（碎句合并为一条）；worker 线协议、IPC、UI 组件与持久化不变。
- `turn-committed` 事件仍逐 utterance 投影，保留真实语音段证据；conversation runtime 的 append 时机从 committed 即时改为 settle 结算时。

## 决定

## 决定

在 assembler 之上新增 `CandidateTurnSettler` 合并层（`turns/settler.ts`），host 中 committed turn 不再立即进入 `ConversationRuntime`：

- **settle 窗口合并**：committed turn 先挂起窗口 `DEFAULT_CANDIDATE_TURN_SETTLE_MS = 1_000ms`；窗口内同会话的下一个 committed turn 顺延窗口并合并；窗口耗尽（或会话 `interview-stop` 的显式结算）时，把窗口内全部 turns 合并成**一条**用户消息。
- **最小有效轮**：合并后 trim 长度 `< MIN_CANDIDATE_TURN_CHARS = 2` 的轮次（典型如单字"嗯"）不进入对话、也不发出事件。
- **失败/丢弃路径**：`failSession`、`interview-capture-failed` 显式丢弃挂起轮；宿主 `dispose` 时 `discardAll`，不做异步结算（避免与 `runtime.dispose` 竞争）。
- 合并文本按 chunkIndex 排序后 join，与 assembler 的块序语义一致。
- 默认窗口 1_000ms 是初始值（覆盖"VAD 500ms 闭合 + 整段 Paraformer 解码延迟"的到达间隔），**待真实面试样本校准**；`AgentHostOptions.turnSettler` 允许测试与组合根覆盖。

## 曾考虑的替代方案

- **调大 `VAD_CLOSE_SILENCE_MS`**：舍弃（作为独立手段）。它降低单 utterance 内误切，但换气停顿本就该闭合；延迟上限若调到数秒会拖垮所有实时反馈，且句子间停顿（>1s）仍会碎。
- **把合并塞进 `InterviewTurnAssembler`**：舍弃。assembler 的注释与契约明确"聚合单一 utterance、不合并跨 utterance"；settle 是跨 utterance 的时间窗决策，塞进去会让纯函数式聚合器引入时钟依赖。
- **只做最小轮丢弃**：舍弃（单独做）。治标——"嗯"消失但"那能真实"+“的嗯”式碎句仍在；与合并同批交付才有完整效果。
- **在 UI/desktop 层合并消息**：舍弃。会话事实来源在 Agent runtime，投影层的合并会制造两个真相。

## 后果与防回退

- 消息出现延迟上限 = settle 窗口；整体在"整段批式 ASR"延迟之上仍属同量级，但必须如实在 Note 记录：**本窗口是拍的初值，未经真实现场校准**；校准证据（真实面试样本）出现前不得宣称它是"最优值"。
- 窗口间隙 >1s 的真实换轮不会被误合并（这正是期望）；反之若 Paraformer 解码延迟大于窗口，合并会退化——校准时优先看这条。
- <2 字 utterance 内容彻底不进对话：把有意义的单字确认（如"对"）也一并吞掉是**已知取舍**；若未来需要保留，必须改为"短轮挂起、由后续语义决定"而不是简单提高阈值。
- `settleMs <= 0` 语义为"每 turn 立即结算"（测试快路径），不承担合并职责；不要用它当"关闭延迟"的生产配置。

## 风险

- 合并层依赖墙钟 `setTimeout`；VAD 强切上限 `VAD_MAX_CHUNK_MS=4500` 之外的长段依然独立成段，长 utterance 的合并覆盖不足。
- agent worker 只在 candidate 通道上执行合并；interviewer 通道事件不经 settler——barge-in（interviewer 打断）落地时需重新评估该窗口的交互。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/interview/turns`：10 项通过（settle 合并、chunkIndex 排序、窗口顺延、短轮丢弃、flush/discard/discardAll）。
- `pnpm --filter @answra/agent exec vitest run test/worker/host.test.ts`：15 项通过，覆盖双段 VAD 语音合并为一条用户消息、`interview-stop` 显式结算、单字 utterance 不上屏三条整合路径。
- `pnpm verify` 与 `pnpm notes:check`：通过。
- 真实耳机/开麦场景的窗口校准与误吞单字确认的实机验证**未做**；完成前不宣称现场体验达标。
