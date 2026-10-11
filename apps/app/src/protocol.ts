import type { ConversationModelConfig, ConversationSendRequest } from "@answra/shared";

export type AppCommand =
  | { id: string; type: "configure"; config: ConversationModelConfig }
  | { id: string; type: "send"; request: ConversationSendRequest }
  | { id: string; type: "cancel"; runId: string }
  | { id: string; type: "shutdown" };

export type AppFrame =
  | { version: 1; type: "response"; id: string; ok: true; value?: unknown }
  | { version: 1; type: "response"; id: string; ok: false; error: string }
  | { version: 1; type: "event"; event: import("@answra/shared").ConversationEvent };
