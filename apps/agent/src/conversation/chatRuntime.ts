import type { ConversationSendRequest } from "@answra/shared";
import type { ChatProfileId } from "./profiles";
import { CHAT_PROFILES } from "./profiles";
import { ConversationRuntime } from "./runtime";

/** Conversation-only runtime extension; answer builds depend on the base runtime directly. */
export class ChatConversationRuntime extends ConversationRuntime {
  async sendChat(
    profileId: ChatProfileId,
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string }> {
    const profile = CHAT_PROFILES[profileId];
    if (!profile) throw new Error("未授权的对话能力配置");
    return this.startRun(
      conversationId,
      request,
      accessToken,
      profile.systemPrompt,
      profile.includeHistory,
      false,
      profile.injectTime ?? false,
      profile.tools,
    );
  }
}
