# Note：面试模式麦克风对话输入

状态：提案

## 问题

面试语音试用面板目前以转录审阅列表呈现，不能像普通对话一样输入并提交用户消息。普通对话的发送路径会立即创建 Agent 模型 run，而面试阶段需要先验证麦克风采集、ASR、turn 结束判断和实时交互感，暂时不生成回答。当前面试管线已具备 PCM/VAD/ASR 与 turn 领域类型，但尚无 turn 聚合器，也无 append-only 用户消息写入操作。

## 涉及范围

- 代码/模块：`apps/agent/src/interview` turn 聚合；`apps/agent/src/conversation` 仅追加用户消息；worker、shared channel/bridge、desktop IPC 投影；`apps/desktop/src/renderer` 麦克风电平观测；`packages/ui` 面试对话式面板及测试。
- UI/进程/协议/持久化表面：用户点击麦克风后仅采集麦克风；识别完成的 turn 作为当前面试对话中的 user message 显示。沿用现有进程内存 conversation store，不新增磁盘持久化。面试系统声音暂不采集、不触发消息；后续另行切换输入源。
- 相关 Note：[面试实时语音人工试用闭环](../../implemented/feature/2026-10-22-live-audio-test-loop.md)、[VAD 评测以 turn 判定与响应延迟为主](../../implemented/testing/2026-10-21-vad-turn-latency-evaluation.md)、[面试语音运行时模块边界与并行开发契约](../architecture/2026-10-19-interview-runtime-module-boundaries.md)、[产品方向与 Agent 底座](../architecture/2026-10-20-product-direction-and-agent-foundation.md)。

## 提案

面试面板采用普通对话消息流与输入区风格，复用 `ChatPanel`/`ConversationComposer` 的消息呈现、`MessageStream`、`PanelShell` 和设计 token。空闲输入区提供小型麦克风按钮；启动后输入框区域替换为实时音量波形和停止控制。波形值必须来自当前麦克风 `MediaStream` 的实际电平采样，采集/会话停止或失败时释放采样资源并停止波形更新。

语音源仅为麦克风，对应 `candidate` PCM source。VAD 产出的 `continuation` 片段只等待后续片段；自然 `utterance-end` 后 turn 聚合器按 `utteranceId/chunkIndex` 等待片段解码结果，所有片段有序且无 gap 时提交完整 turn。缺片、ASR 错误、session 失效或用户停止时不得把不完整文本作为已提交消息发送；停止时 segmenter 的 flush 不伪装成自然 turn-end。turn 提交后通过独立 append-only Conversation 命令写入 user message，不调用 `sendConversationMessage`/`chat-send`，不启动模型 run。手动文本输入走同一 append-only 用户消息路径。

当前 turn 范围是一条 VAD utterance（含其 continuation chunks），不是跨多个静音 utterance 的语义合并。实机试用若显示句内停顿导致拆分，再基于可观察事件与标注重新调整 settle/合并窗口并另行记录；不以任意固定等待掩盖 turn 定义。

## 影响表面

- Agent 负责 turn 生命周期和只追加用户消息；turn 的提交状态来源于 VAD 自然结束与完整有序 ASR 结果。
- worker/shared/desktop 明确投影 append-only 用户消息请求与 ConversationChange；preload 只转发，renderer 不直接操作 Agent store。
- Renderer 采集适配器以有界频率发布麦克风真实音量指标，负责 AudioContext/track/定时器清理。
- UI 的 user message 使用既有普通对话气泡；采集状态、权限失败和停止状态使用现有中性控件样式。

## 曾考虑的替代方案

- **复用普通对话发送 API：** 舍弃。该 API 会创建 Agent run 并生成 assistant 回复，违反本阶段只验证语音输入与 turn 发送的边界。
- **将 transcript 继续显示为说话方审阅列表：** 舍弃。不能验证“获得 turn 内容后像普通用户消息一样进入对话”的产品体验。
- **把每个 ASR chunk-final 或 VAD utterance-end 立即追加为消息：** 舍弃。chunk 不是 turn；utterance-end 也可能有缺失的 continuation chunk 或识别失败，必须等 assembler 提交。
- **用 CSS/随机动画模拟波形：** 舍弃。它不能证明麦克风当前确有输入，也会掩盖静音/权限/设备问题。
- **本期同时监听系统声音：** 暂缓。用户明确选择先以麦克风作为用户输入，系统声音转入该路径待真实麦克风流程验证后再做。

## 后果与防回退

- 普通消息视觉可复用；普通对话模型发送行为不可复用。append-only 操作不得隐式配置/调用模型。
- 用户消息只在当前 Agent 进程内存保留；停止应用后不承诺保留历史。
- turn 提交以单一 assembler 为唯一 writer；迟到 ASR 结果按 session/turn 身份丢弃；同一 turn 至多追加一次。
- 真实波形只能来自当前麦克风流；不可从帧计数或 VAD 状态推演音量。
- UI 自动化证明消息/状态映射；目标 Windows 麦克风实测才证明设备权限、电平和实时交互。未实测前不宣称面试可用。

## 验收标准

- 用户点击麦克风后启动采集；真实输入变化会改变波形，静音时波形接近静止，停止/失败后采集轨和电平更新都结束。
- 麦克风语音经 VAD/ASR 后，在完整自然 turn 提交时只出现一条普通 user message；多 chunk 按序合并，缺片/错误/手动停止不会误发半句。
- 手动输入文本也能以普通 user message 显示；两种输入均不启动 assistant run、不产生回复。
- worker/IPC sender、session 生命周期与现有音频 credit 流程保持明确验证；任何停止、错误或重启均丢弃过期结果。
- `pnpm verify` 与 `pnpm notes:check` 通过；Windows 实机验证麦克风权限、真实电平、ASR 延迟、turn 正确性和语音/文本消息显示。实机结果记录后再迁移 Note 到 `implemented/`。

## 风险

- 本机模型、VAD 资产或麦克风权限未就绪时，不能通过自动化测试证明真实输入体验；必须由用户在目标 Windows 设备启动应用实测。
- 当前消息只保存在 Agent 进程内存，应用退出后历史丢失；本期目标是验证实时交互，不承诺历史持久化。
- 自然 turn 按单个 VAD utterance 提交，句内长停顿可能形成多条消息；是否需要合并只能根据实测反馈调整。
