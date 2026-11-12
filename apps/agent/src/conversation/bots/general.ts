import type { AgentRuntime } from "../../core/agent/runtime";
import type { ToolRegistry } from "../../core/tool";
import type { ConversationStore } from "../../core/transcript/store";
import { createConversationBot } from "./create";
import type { ConversationBot } from "./types";

export function createGeneralConversationBot({
  agentRuntime,
  store,
  tools,
}: {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  tools: ToolRegistry;
}): ConversationBot {
  return createConversationBot({ agentRuntime, store, tools });
}
