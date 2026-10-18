import type {
  AnswerRunCommand,
  ChatSendCommand,
  ConversationChange,
  ConversationModelConfig,
} from "@answra/shared";

/**
 * desktop main ↔ agent worker 的线协议：命令下行、帧上行。
 * 只有这里出现在 utility process 边界上，会话与模型细节留在 src 内部。
 *
 * 平台能力（如刷新云端访问令牌）由宿主实现：agent 只上行「请求帧」，宿主用命令帧回答。
 * agent 不持有宿主 API，也不接触磁盘上的凭据。
 */
export type AgentCommand =
  | { id: string; type: "configure"; config: ConversationModelConfig }
  | ({ id: string; type: "chat-send"; accessToken: string } & ChatSendCommand)
  | ({ id: string; type: "answer-run"; accessToken: string } & AnswerRunCommand)
  /** 宿主对 `token-request` 的回答：`accessToken` 与 `error` 二者必居其一。 */
  | { id: string; type: "token"; accessToken?: string; error?: string }
  | { id: string; type: "snapshot"; conversationId: string }
  | { id: string; type: "read-events"; conversationId: string; afterRevision: number }
  | { id: string; type: "create-conversation"; conversationId: string }
  | { id: string; type: "cancel"; runId: string }
  | { id: string; type: "shutdown" };

export type AgentFrame =
  | { version: 1; type: "response"; id: string; ok: true; value?: unknown }
  | { version: 1; type: "response"; id: string; ok: false; error: string }
  | { version: 1; type: "change"; change: ConversationChange }
  /** 反向请求：云端调用收到 401 时，请宿主换一次新的访问令牌。 */
  | { version: 1; type: "token-request"; id: string; forceRefresh: boolean };
