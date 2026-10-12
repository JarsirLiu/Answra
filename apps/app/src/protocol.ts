import type { ConversationModelConfig, ConversationSendRequest } from "@answra/shared";

export type AppCommand =
  | { id: string; type: "configure"; config: ConversationModelConfig }
  | { id: string; type: "send"; conversationId: string; request: ConversationSendRequest }
  | { id: string; type: "snapshot"; conversationId: string }
  | { id: string; type: "read-events"; conversationId: string; afterRevision: number }
  | { id: string; type: "create-conversation"; conversationId: string }
  | { id: string; type: "cancel"; runId: string }
  | { id: string; type: "shutdown" };

export type AppFrame =
  | { version: 1; type: "response"; id: string; ok: true; value?: unknown }
  | { version: 1; type: "response"; id: string; ok: false; error: string }
  | { version: 1; type: "change"; change: import("@answra/shared").ConversationChange };
