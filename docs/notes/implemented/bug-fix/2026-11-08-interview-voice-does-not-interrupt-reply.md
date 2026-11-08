# Note：面试语音确认后打断辅助回答

状态：已实施

## 问题

面试辅助场景中，候选人开口只是为了让 ASR 识别下一条问题或补充内容。VAD 的语音活动不能直接打断 AI，但确认后的 ASR turn 必须像普通发送一样中断当前回复并发起下一次请求；此前回复循环却等待当前 AI 自然完成，导致已确认的用户消息迟迟不发送。

## 涉及范围

- `apps/agent/src/interview/runtime.ts`：VAD 与回复应用的连接
- `apps/agent/src/interview/application.ts`：面试回复应用端口
- `apps/agent/src/interview/reply/loop.ts`：已确认 turn 的排队与回复生命周期
- `apps/agent/src/interview/vad/pipeline.ts`：语音活动观察回调说明
- `packages/ui/src/components/panels/InterviewCapturePanel.tsx`：首 token 前运行图标

## 根因

`InterviewVadPipeline` 将 `speech-started` 传入 `InterviewApplication`，旧的 `InterviewReplyLoop.speechStarted()` 直接调用 `cancelReply()`。这条连接把媒体活动误当成了模型回复控制命令。

## 修复

- **产品决定：** 用户说话期间 AI 回复继续运行。ASR 识别并确认 turn 后，才取消当前 run、追加用户消息并请求下一次 AI 回复。
- **实现：** 删除语音开口到回复循环的调用，移除 `speechEpoch` 和触发源策略；turn settle 经 InterviewApplication 端口取消当前 run，等待取消完成后追加消息和启动回复。停止面试仍调用同一个取消 API。
- **UI：** 面试面板消费已有 `waitingForStream` 字段，使用 `LoaderCircle` 显示首 token 等待动画；共享动画样式移入共用消息流样式。

## 决定

- VAD、ASR 和 turn assembler 只负责采集、识别和确认文本，不直接操作 AI run。
- 只有确认后的 `turnSettled` 才通过 `InterviewApplication` 的 `appendUserTurn` 和 `startReply` 端口调用正常回复 API。
- 当前 AI 回复自然完成前，后续已确认 turn 会经正常取消 API 中断当前 run；不会因 `speech-started` 取消当前 run。
- 停止面试时仍通过 `cancelReply` API 取消活动 run，这是会话生命周期控制，不是语音打断策略。
- 不新增事件或状态字段；沿用已有 transcript、run 和 AgentEventEnvelope。

## 曾考虑的替代方案

- **开口立即取消模型回复：** 这是实时语音对话语义，会把面试辅助误当成一对一语音对话，因此只在 ASR turn 确认后发送。
- **让 VAD 或 ASR 直接调用模型运行时：** 会让媒体领域依赖 AI 执行细节，形成第二条发送路径，因此舍弃。
- **未确认 ASR 文本就启动回复：** 会把临时识别结果写入对话并触发错误回答，因此舍弃。

## 后果与防回退

- 用户开口期间 AI 可以继续输出；语音识别完成并确认后，文本通过取消、追加、启动三步正常 API 链路进入 transcript 并启动下一轮回复。
- 回复循环仍保持单一活动 run；新 turn 不会绕过 `InterviewApplication` 的 API 端口。
- 后续若产品需要实时语音打断，必须作为独立的明确产品策略重新设计，不能把 VAD 回调直接接回 `cancelReply`。

## 验证

- `apps/agent/test/interview/reply/loop.test.ts` 保留确认 turn 排队、停止取消、会话代际隔离和失败收口覆盖。
- `pnpm --filter @answra/agent typecheck`
- `pnpm --filter @answra/agent exec vitest run test/interview/reply/loop.test.ts`
