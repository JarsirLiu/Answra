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
  activeMessageId?: string;
  retry?: ConversationRetry;
  error?: string;
  clearMessages: () => void;
}

/**
 * 回复详情只读本轮会话：复用唯一投影，额外要求保留答题结束后的已捕获轮次，
 * 并跟踪工具/来源/错误等活动卡片。
 *
 * Answer 与常驻会话共用同一套 durable 帧投影。
 */
export function useReplyConversation(
  platform: DesktopBridge | undefined,
  conversationId: string | undefined,
  enabled: boolean,
): ReplyConversationState {
  const { view, clear } = useConversationView(platform, conversationId, {
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
    activeMessageId: view.activeMessageId,
    retry: view.retry,
    error: view.error,
    clearMessages: clear,
  };
}
