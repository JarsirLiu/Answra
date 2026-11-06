import type { DesktopBridge, ReplyBarActivity } from "@answra/shared";
import type {
  ConversationRetry,
  ConversationViewMessage,
} from "../components/chat/conversationMessage";
import { useConversationView } from "./useConversationView";

export interface ReplyConversationMessage extends ConversationViewMessage {
  activities: readonly ReplyBarActivity[];
}

interface ReplyConversationState {
  messages: ReplyConversationMessage[];
  activeRunId?: string;
  retry?: ConversationRetry;
  error?: string;
}

/**
 * 回复详情只读本轮会话：复用唯一投影，额外要求保留答题结束后的已捕获轮次，
 * 并跟踪工具/来源/错误等活动卡片。
 */
export function useReplyConversation(
  platform: DesktopBridge | undefined,
  conversationId: string | undefined,
  enabled: boolean,
): ReplyConversationState {
  const { view } = useConversationView(platform, conversationId, {
    enabled,
    create: false,
    retainCapturedRound: true,
    trackActivities: true,
  });
  return {
    messages: view.messages.map((message) => ({
      ...message,
      activities: message.activities ?? [],
    })),
    activeRunId: view.activeRunId,
    retry: view.retry,
    error: view.error,
  };
}
