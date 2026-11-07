import type { ConversationSnapshot, DesktopBridge } from "@answra/shared";
import type { ConversationView } from "./conversationView";
import { useConversationView } from "./useConversationView";

/** 面试会话复用唯一投影；面试面板与对话面板消费同一份消息模型。 */
export function useInterviewConversation(
  platform: DesktopBridge | undefined,
  conversationId: string,
): {
  view: ConversationView;
  reconcileSnapshot: (snapshot: ConversationSnapshot) => Promise<void>;
} {
  const { view, reconcileRunSnapshot } = useConversationView(platform, conversationId, {
    enabled: __ANSWRA_FEATURE_INTERVIEW__,
    create: true,
  });
  return { view, reconcileSnapshot: reconcileRunSnapshot };
}
