import type { ConversationChange, DesktopBridge } from "@answra/shared";
import { useEffect, useState } from "react";
import {
  applyInterviewChange,
  EMPTY_INTERVIEW_CONVERSATION,
  type InterviewConversationView,
} from "./interviewConversation";

/** 订阅面试会话并把 ConversationChange 折叠成面板可渲染的消息视图。 */
export function useInterviewConversation(
  platform: DesktopBridge | undefined,
  conversationId: string,
): InterviewConversationView {
  const [view, setView] = useState(EMPTY_INTERVIEW_CONVERSATION);

  useEffect(() => {
    if (!__ANSWRA_FEATURE_INTERVIEW__) return;
    if (!platform?.createConversation || !platform.getConversationSnapshot) return;
    let alive = true;
    const apply = (change: ConversationChange) => {
      if (!alive) return;
      setView((current) => applyInterviewChange(current, change, conversationId));
    };
    const unsubscribe = platform.onConversationChange?.(apply);
    void platform
      .createConversation(conversationId)
      .then((snapshot) => apply({ type: "snapshot", snapshot }))
      .catch((error: unknown) => {
        console.warn("[interview] failed to create conversation", error);
      });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [platform, conversationId]);

  return view;
}
