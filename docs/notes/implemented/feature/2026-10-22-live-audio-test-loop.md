# Note：面试实时语音人工试用闭环

状态：已实施

Windows 实机试用待用户验收。

## 问题

当前仓库已将 Windows loopback PCM 接入 Agent 的 TEN VAD 与本地 Paraformer，但面试 renderer 没有转写订阅；shared PCM 只允许 `interviewer` 来源。VAD 按静音阈值产出 utterance segment，转写结果也没有投影到 UI。因此用户无法实际判断真实设备上的延迟、文本语义和端点是否有实时对话感。

## 涉及范围

- 代码/模块：`packages/shared` PCM 来源与面试事件契约；`apps/desktop` 麦克风采集、受限媒体权限、IPC 和事件投影；`apps/agent` 双源 VAD/ASR 与 segment boundary；`packages/ui` 实时转写审阅界面。
- UI/进程/协议/持久化表面：仅 Windows 开发试用；转写仅驻留当前会话内存，不生成回答、不落盘。
- 相关 Note：[持续面试助手提案](../../proposed/feature/2026-10-12-live-interview-assistant.md)、[turn-end 评测](../testing/2026-10-21-vad-turn-latency-evaluation.md)、[本地转录宿主接线](2026-10-21-interview-transcription-host-wiring.md)。

## 决定

同一批闭合最小试用链路：Windows 启动时同时请求 loopback 与麦克风；PCM 以独立 source sequence 流入 Agent 现有按来源隔离的 VAD 与本地 ASR；main 将 chunk-final 与 VAD segment boundary 投影为 renderer 面试事件；面板显示说话方、文本、时间和 interviewer `utterance-end`。会话文本只在内存保留，最多 60 行，停止后可审阅，下一次开始时清空。不连接回答模型。

`utterance-end` 是 VAD 静音端点，不是已完成语义聚合的 interviewer turn，也不等同于应发送 AI 消息。当前面板把它显示为“检测到对方停顿”。采集中的帧累计数只是 Agent PCM 接收确认，不是转录进度或识别结果；面板用固定提示说明音频已送达识别链路，转写应在语音片段结束后显示。面板按钮复用悬浮导航条的中性 `SurfaceButton` 样式，状态用同色线性图标表达，不使用彩色状态点或品牌色实底。`pnpm bootstrap` 保持既有含义；语音资源另用 `vad:prepare` 与 `asr:prepare`，README 已补充完整开发启动步骤。

## 影响表面

- shared PCM 帧支持 interviewer/candidate 两路；Agent 现有 `AudioSource` 为每个来源隔离 sequence、VAD hop 和 segmenter。
- Desktop main 校验来源并将 chunk-final 投影成 shared transcript event；preload 只转发。
- Electron media 权限仅在活动采集启动期间授予受信主窗口主 frame 的 audio-only `getUserMedia` 和系统 display-capture 请求；所有其它媒体权限拒绝。
- renderer 在面试面板显示分说话方的文本、VAD utterance-end 和收到时间；会话文本有界且不落盘。

## 曾考虑的替代方案

- **只改离线评测并用 CER 判定：** 舍弃。数据集标注不总是可信，离线音频时间轴延迟也不能代表真实采集的墙钟时间。
- **本批接入回答生成：** 舍弃。用户需要先人工感受语音响应和 turn 准确性；回答策略会干扰这项验证，后续单独决策。
- **把 VAD/ASR 大资源加到 `pnpm bootstrap`：** 暂不采用。通用开发初始化会变慢且额外下载约 82MB 模型；保留可选独立准备命令，试用说明显式列出它们。

## 后果与防回退

- 当前显示的是 VAD 语音段边界，不得称为 semantic turn 或自动回复触发；turn settle 与主 Agent 发消息/攒批策略尚未实现。
- candidate transcript 映射到用户发言，不能冒充 interviewer 端点或触发后续提问处理。
- transcript 仅保留在 renderer 当前进程内存；不写文件、不进日志。单次会话最多保留最近 60 条，下一次 start 清空。
- `pnpm bootstrap` 不隐式下载 ASR 模型；新机器须额外执行 `vad:prepare` 与 `asr:prepare`。

## 风险

- `VAD_CLOSE_SILENCE_MS=500` 在离线样本上 EOT recall 89.47%、轮内误切 19.77%；该速度偏好尚未用真实 loopback 校准。
- 本地 Paraformer 是整段解码，不产出 partial；文本通常在 utterance-end 后出现，实时感取决于端点和同步解码总延迟。
- 双源音频经同一 Agent 串行解码，可能互相排队；需在目标机器实测。
- 麦克风可能采到扬声器回声；首版提供来源标签，不做回声消除。

## 验证

- `pnpm --filter @answra/desktop typecheck`：通过。
- `pnpm --filter @answra/agent typecheck`：通过。
- `pnpm --filter @answra/ui exec vitest run test/InterviewCapturePanel.test.tsx`：3 项通过。
- `pnpm --filter @answra/desktop exec vitest run test/interviewIpc.test.ts`：1 项通过，覆盖两路来源接受及 utterance-end 投影。
- `pnpm --filter @answra/agent exec vitest run test/interview/transcription/local.test.ts test/interview/contracts.test.ts test/worker/host.test.ts`：22 项通过。
- `pnpm verify`：lint、全部 workspace typecheck、Agent 85 项、UI 250 项、Desktop 284 项和 architecture check 全通过；Desktop 1 项既有测试跳过。
- `pnpm notes:check`：通过。
- Windows 开发机 `pnpm --filter @answra/desktop asr:prepare`：从 hf-mirror 下载模型、tokens 与许可证并通过固定 revision/SHA-256 校验；VAD 资源已存在。
- `git diff --check`：通过；语音模型位于忽略的本地 resources 目录，不进入变更。
- Windows 真实会议软件、麦克风权限、误切和墙钟延迟尚未实测；完成前不宣称达到面试可用标准。
