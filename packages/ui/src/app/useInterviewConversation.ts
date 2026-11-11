import type { ConversationSnapshot, DesktopBridge } from "@answra/shared";
import { useCallback } from "react";
import type { ConversationView } from "./conversationView";
import { useConversationView } from "./useConversationView";

/** 面试会话复用唯一投影；面试面板与对话面板消费同一份消息模型。 */
export function useInterviewConversation(
  platform: DesktopBridge | undefined,
  conversationId: string,
): {
  view: ConversationView;
  reconcileSnapshot: (snapshot: ConversationSnapshot) => Promise<void>;
  clearMessages: () => void;
  cancel: () => void;
} {
  const { view, reconcileRunSnapshot, clear } = useConversationView(platform, conversationId, {
    enabled: __ANSWRA_FEATURE_INTERVIEW__,
    create: true,
  });
  const cancel = useCallback(() => {
    if (view.activeRunId) platform?.cancelConversationRun?.(view.activeRunId);
  }, [platform, view.activeRunId]);
  return { view, reconcileSnapshot: reconcileRunSnapshot, clearMessages: clear, cancel };
}
