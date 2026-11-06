/** 通用聊天 profile 到 Conversation 回合入口的薄组合适配器。 */
import type { ConversationSendRequest } from "@answra/shared";
import type { ChatProfileId } from "../profiles/registry";
import { CHAT_PROFILES } from "../profiles/registry";
import { ConversationRuntime } from "./runtime";

export class ChatConversationRuntime extends ConversationRuntime {
  async sendChat(
    profileId: ChatProfileId,
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string }> {
    const profile = CHAT_PROFILES[profileId];
    if (!profile) throw new Error("未授权的对话能力配置");
    return this.startRun({
      conversationId,
      request,
      accessToken,
      systemPrompt: profile.systemPrompt,
      includeHistory: profile.includeHistory,
      ephemeral: false,
      injectTime: profile.injectTime ?? false,
      authorizedTools: profile.tools,
    });
  }

  /** Generates an assistant turn for the last user message already in the store. */
  async replyToLastUser(
    profileId: ChatProfileId,
    conversationId: string,
    getAccessToken: () => Promise<string>,
  ): Promise<{ runId: string }> {
    const profile = CHAT_PROFILES[profileId];
    if (!profile) throw new Error("未授权的对话能力配置");
    return this.replyToLastUserWithProfile(profile, conversationId, getAccessToken);
  }
}
