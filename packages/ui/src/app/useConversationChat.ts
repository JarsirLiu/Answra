import type { DesktopBridge, ReplyBarActivity } from "@answra/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatAttachment } from "../components/panels/ChatPanel";
import { useConversationView } from "./useConversationView";

function useAiConversation(
  platform: DesktopBridge | undefined,
  conversationId: string,
  operation: "chat.send" | "answer.run" = "chat.send",
) {
  const { view, selectConversation, waitForRun, getView, clear } = useConversationView(
    platform,
    conversationId,
    { trackActivities: true },
  );
  const [sendPending, setSendPending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [hideActivities, setHideActivities] = useState(false);
  const lastActivityMessageIdRef = useRef<string | undefined>(undefined);
  const cancelRequestedRef = useRef(false);
  const [thinkingMs, setThinkingMs] = useState<number>();
  const runStartRef = useRef<number | undefined>(undefined);
  const thinkingSetRef = useRef(true);

  useEffect(() => {
    if (!hideActivities) return;
    const lastAssistant = [...view.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (
      !lastActivityMessageIdRef.current ||
      lastAssistant?.id !== lastActivityMessageIdRef.current
    ) {
      setHideActivities(false);
    }
  }, [hideActivities, view.messages]);

  // 思考耗时：从本轮发起计时，到助手正文出现第一个字为止。
  useEffect(() => {
    if (thinkingSetRef.current || !view.activeRunId) return;
    const active = view.messages.find((message) => message.id === view.activeRunId);
    if (active?.text && runStartRef.current !== undefined) {
      thinkingSetRef.current = true;
      setThinkingMs(Date.now() - runStartRef.current);
    }
  }, [view.activeRunId, view.messages]);

  const replyActivities = useMemo<ReplyBarActivity[]>(() => {
    if (hideActivities) return [];
    const message = view.activeRunId
      ? view.messages.find((item) => item.id === view.activeRunId)
      : [...view.messages].reverse().find((item) => item.role === "assistant");
    return [...(message?.activities ?? [])];
  }, [hideActivities, view.activeRunId, view.messages]);

  const send = useCallback(
    async (text: string, attachments: ChatAttachment[], targetConversationId = conversationId) => {
      if (!platform?.sendConversationMessage)
        throw new Error("本地 AI 服务未连接，请重启应用后重试");
      if (view.activeRunId || sendPending) throw new Error("当前回复尚未完成");
      setSendError(undefined);
      setSendPending(true);
      thinkingSetRef.current = false;
      setThinkingMs(undefined);
      runStartRef.current = Date.now();
      cancelRequestedRef.current = false;
      const previousAssistant = [...view.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      lastActivityMessageIdRef.current = previousAssistant?.id;
      setHideActivities(Boolean(previousAssistant));
      try {
        const images = await Promise.all(
          attachments.map(async (attachment) => ({
            name: attachment.name,
            dataUrl: attachment.previewUrl.startsWith("data:")
              ? attachment.previewUrl
              : await blobUrlToDataUrl(attachment.previewUrl),
          })),
        );
        if (targetConversationId !== conversationId) {
          selectConversation(targetConversationId);
          await platform.createConversation?.(targetConversationId);
        }
        const command =
          operation === "chat.send"
            ? {
                operation,
                profileId: "general-chat" as const,
                conversationId: targetConversationId,
                request: { text, images },
              }
            : { operation, conversationId: targetConversationId, request: { text, images } };
        const { runId } = await platform.sendConversationMessage(command);
        if (cancelRequestedRef.current) platform.cancelConversationRun?.(runId);
        const outcome = await waitForRun(runId);
        if (outcome === "aborted" || outcome === "superseded") return "cancelled";
        const runError = getView().error;
        if (runError) throw new Error(runError);
        if (outcome === "failed") throw new Error("模型请求失败");
        return runId;
      } catch (error) {
        setSendError(error instanceof Error ? error.message : "发送失败");
        throw error;
      } finally {
        setSendPending(false);
      }
    },
    [
      platform,
      operation,
      conversationId,
      view.activeRunId,
      view.messages,
      sendPending,
      selectConversation,
      waitForRun,
      getView,
    ],
  );

  const cancel = useCallback(() => {
    cancelRequestedRef.current = true;
    if (view.activeRunId) platform?.cancelConversationRun?.(view.activeRunId);
  }, [platform, view.activeRunId]);

  const clearMessages = useCallback(() => {
    clear();
    setSendError(undefined);
    setThinkingMs(undefined);
    setHideActivities(false);
    lastActivityMessageIdRef.current = undefined;
  }, [clear]);

  return {
    activeRunId: view.activeRunId,
    cancel,
    clearMessages,
    messages: view.messages,
    replyError: sendError ?? view.error,
    replyPending: Boolean(view.activeRunId || sendPending),
    replyActivities,
    retry: view.retry,
    send,
    thinkingMs,
  };
}

export function useGeneralChat(platform: DesktopBridge | undefined, conversationId: string) {
  return useAiConversation(platform, conversationId, "chat.send");
}

export function useScreenshotAnswer(platform: DesktopBridge | undefined, conversationId: string) {
  return useAiConversation(platform, conversationId, "answer.run");
}

async function blobUrlToDataUrl(url: string): Promise<string> {
  const blob = await fetch(url).then((response) => response.blob());
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("无法读取图片"));
    reader.onerror = () => reject(reader.error ?? new Error("无法读取图片"));
    reader.readAsDataURL(blob);
  });
}
