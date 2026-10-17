import type { ConversationModelConfig, ConversationSendRequest } from "@answra/shared";

/**
 * desktop main ↔ agent worker 的线协议：命令下行、帧上行。
 * 只有这里出现在 utility process 边界上，会话与模型细节留在 src 内部。
 */
export type AgentCommand =
  | { id: string; type: "configure"; config: ConversationModelConfig }
  | { id: string; type: "send"; conversationId: string; request: ConversationSendRequest }
  | { id: string; type: "snapshot"; conversationId: string }
  | { id: string; type: "read-events"; conversationId: string; afterRevision: number }
  | { id: string; type: "create-conversation"; conversationId: string }
  | { id: string; type: "cancel"; runId: string }
  | { id: string; type: "shutdown" };

export type AgentFrame =
  | { version: 1; type: "response"; id: string; ok: true; value?: unknown }
  | { version: 1; type: "response"; id: string; ok: false; error: string }
  | { version: 1; type: "change"; change: import("@answra/shared").ConversationChange };
