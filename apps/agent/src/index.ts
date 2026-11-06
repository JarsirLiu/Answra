/**
 * @answra/agent 公共入口：desktop 的 worker 只从这里导入。
 *
 * 目录分层（按领域切分，新增领域平行加目录，减少并行开发的改动冲突）：
 *   worker/host.ts          组装点：传输 + 运行时 + 命令分发
 *   worker/protocol.ts      worker 线协议（与 desktop main 之间的唯一契约）
 *   conversation/session/ 会话 transcript、快照、revision 与仓储
 *   conversation/turn/    对话/答题的一次回复回合与模型流编排
 *   conversation/profiles/ Agent 注册的提示词、上下文策略与工具授权
 *   conversation/tools/   Conversation 领域内的工具与静态授权
 *
 * Agent 工具在本进程实现；桌面平台能力（读屏/音频采集、键鼠注入、窗口）由 desktop
 * 适配。该包不依赖 Electron 与 React，worker transport 由宿主单独装配。
 */

export { MemoryConversationStore } from "./conversation/session/memoryStore";
export type { ConversationStore } from "./conversation/session/store";
export { ChatConversationRuntime } from "./conversation/turn/chatRuntime";
export { ConversationRuntime } from "./conversation/turn/runtime";
export { MemoryExecutionStore } from "./execution/memoryStore";
export type { ExecutionStore } from "./execution/store";
export type {
  OfflineRecognizerModule,
  OfflineRecognizerRecipe,
  OfflineRecognizerSession,
  RecognizerAssembly,
  RecognizerSource,
} from "./interview/transcription/local/recognizerPort";
export { TEN_VAD_ONSET_THRESHOLD } from "./interview/vad/config";
export type { InterviewVadPipelineOptions } from "./interview/vad/pipeline";
export { InterviewVadPipeline } from "./interview/vad/pipeline";
export type {
  HopVerdict,
  TenVadEngine,
  TenVadHop,
  TenVadSource,
} from "./interview/vad/tenVadEngine";
export { createTenVadEngine } from "./interview/vad/tenVadEngine";
export {
  type AnswerAgentHost,
  type AnswerAgentHostOptions,
  type AnswerAgentTransport,
  startAnswerAgentHost,
} from "./worker/answerHost";
export type { AgentHost, AgentHostOptions, AgentTransport } from "./worker/host";
export { startAgentHost } from "./worker/host";
export type { AgentCommand, AgentFrame, InterviewWorkerEvent } from "./worker/protocol";
