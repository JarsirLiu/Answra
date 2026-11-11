import {
  ActiveInterviewConversationId,
  type AgentConnectionState,
  type ConversationSnapshot,
  type DesktopBridge,
  isAgentServiceDisconnectedError,
} from "@answra/shared";
import { useCallback, useEffect, useState } from "react";
import { AGENT_SERVICE_UNAVAILABLE_NOTICE } from "../components/chat";
import { InterviewCapturePanel } from "../components/panels/InterviewCapturePanel";
import type { InterviewCapturePort, InterviewCaptureState } from "./interviewCapture";
import { useInterviewConversation } from "./useInterviewConversation";

const START_REHEARSAL_MESSAGE =
  "开始面试演练。请先检查我的面试记忆和简历是否存在，再引导我补充信息；资料齐全后再开始提问。";

export interface InterviewRehearsalPanelProps {
  platform: DesktopBridge | undefined;
  capture: InterviewCapturePort | undefined;
  state: InterviewCaptureState;
  connection?: AgentConnectionState;
  onClear: (conversationId: string) => Promise<ConversationSnapshot>;
  onClose: () => void;
}

/** Owns the interview conversation projection, manual send, and clear flow for the panel. */
export function InterviewRehearsalPanel({
  platform,
  capture,
  state,
  connection,
  onClear,
  onClose,
}: InterviewRehearsalPanelProps) {
  const { view, reconcileSnapshot, clearMessages, cancel } = useInterviewConversation(
    platform,
    ActiveInterviewConversationId,
  );
  const [error, setError] = useState<string>();
  const lastMessage = view.messages.at(-1);
  const replyId = lastMessage?.role === "assistant" ? lastMessage.id : undefined;

  const clearNow = useCallback((): void => {
    setError(undefined);
    void onClear(ActiveInterviewConversationId).catch(() => undefined);
  }, [onClear]);

  useEffect(() => {
    if (replyId || view.activeRunId) setError(undefined);
  }, [replyId, view.activeRunId]);

  useEffect(() => {
    if (connection?.status !== "reconnecting" && connection?.status !== "unavailable") return;
    // 链路断开后旧失败原因已过期：连接提示是唯一主因，重连成功后的空快照再清 transcript。
    setError(undefined);
    clearMessages();
  }, [clearMessages, connection?.status]);

  async function sendText(text: string): Promise<void> {
    setError(undefined);
    if (!platform?.sendInterviewMessage) throw new Error("当前版本不支持发送消息");
    try {
      const { snapshot } = await platform.sendInterviewMessage(ActiveInterviewConversationId, text);
      await reconcileSnapshot(snapshot);
    } catch (sendError) {
      setError(
        isAgentServiceDisconnectedError(sendError)
          ? AGENT_SERVICE_UNAVAILABLE_NOTICE
          : sendError instanceof Error
            ? sendError.message
            : "消息发送失败",
      );
      throw sendError;
    }
  }

  function startRehearsal(): Promise<void> {
    return sendText(START_REHEARSAL_MESSAGE);
  }

  return (
    <InterviewCapturePanel
      capture={capture}
      state={state}
      messages={view.messages}
      retry={view.retry}
      connection={connection}
      error={error ?? view.error}
      onSendText={sendText}
      onStartRehearsal={platform?.sendInterviewMessage ? startRehearsal : undefined}
      onCancel={platform?.cancelConversationRun ? cancel : undefined}
      onClear={clearNow}
      clearDisabledReason={view.messages.length === 0 ? "本场演练还没有对话" : undefined}
      onClose={onClose}
    />
  );
}
