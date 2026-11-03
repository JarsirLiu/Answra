/**
 * 面试对话的纯投影：把 ConversationChange 折叠成消息视图。
 * 只做渲染所需的状态收敛，不推导角色、不合并消息、不创建 run。
 */
import type { ConversationChange, ConversationMessage } from "@answra/shared";

export type InterviewMessageView = Pick<ConversationMessage, "id" | "role" | "text" | "status">;

export interface InterviewConversationView {
  revision: number;
  messages: InterviewMessageView[];
  error?: string;
}

export const EMPTY_INTERVIEW_CONVERSATION: InterviewConversationView = {
  revision: -1,
  messages: [],
};

export function applyInterviewChange(
  view: InterviewConversationView,
  change: ConversationChange,
  conversationId: string,
): InterviewConversationView {
  switch (change.type) {
    case "snapshot": {
      const snapshot = change.snapshot;
      if (snapshot.conversationId !== conversationId || snapshot.revision < view.revision)
        return view;
      return {
        revision: snapshot.revision,
        messages: snapshot.messages.map(toView),
        error: view.error,
      };
    }
    case "messages-appended": {
      if (change.conversationId !== conversationId || change.revision <= view.revision) return view;
      // 新的 assistant 回合开始即清掉上一轮错误；用户消息追加不承担清错职责。
      const startsReply = change.messages.some((message) => message.role === "assistant");
      return {
        revision: change.revision,
        messages: [...view.messages, ...change.messages.map(toView)],
        error: startsReply ? undefined : view.error,
      };
    }
    case "event": {
      const event = change.event;
      if (event.conversationId !== conversationId || event.revision <= view.revision) return view;
      const stream = event.stream;
      if (stream.type === "error")
        return { ...view, revision: event.revision, error: stream.errorText };
      if (stream.type !== "text-delta") return { ...view, revision: event.revision };
      return {
        ...view,
        revision: event.revision,
        messages: view.messages.map((message) =>
          message.id === event.runId ? { ...message, text: message.text + stream.delta } : message,
        ),
      };
    }
    case "run-finished": {
      if (change.conversationId !== conversationId || change.revision <= view.revision) return view;
      return {
        ...view,
        revision: change.revision,
        messages: view.messages.map((message) =>
          message.id === change.runId
            ? { ...message, text: change.message.text, status: change.message.status }
            : message,
        ),
      };
    }
  }
}

function toView(message: ConversationMessage): InterviewMessageView {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    status: message.status,
  };
}
