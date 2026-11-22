import type { DesktopBridge, ReplyBarActivity } from "@answra/shared";
import { isAgentServiceDisconnectedError } from "@answra/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatAttachment } from "../components/panels/ChatPanel";
import { useConversationView } from "./useConversationView";

function useAiConversation(
  platform: DesktopBridge | undefined,
  conversationId: string,
  operation: "chat.send" | "answer.send" = "chat.send",
) {
  const { view, selectConversation, reconcileSnapshot, waitForOutcome, getView, clear } =
    useConversationView(platform, conversationId, {
      trackActivities: operation === "answer.send",
    });
  const [sendPending, setSendPending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [hideActivities, setHideActivities] = useState(false);
  const lastActivityMessageIdRef = useRef<string | undefined>(undefined);
  const cancelRequestedRef = useRef(false);
  // 取消必须作用于本轮真正发送到的会话：Answer 每轮创建新的 screenshot 会话，
  // hook 入参仍是固定答题会话，不能拿它当取消目标。
  const activeConversationIdRef = useRef(conversationId);
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
    if (thinkingSetRef.current || !view.activeMessageId) return;
    const active = view.messages.find((message) => message.id === view.activeMessageId);
    if (active?.text && runStartRef.current !== undefined) {
      thinkingSetRef.current = true;
      setThinkingMs(Date.now() - runStartRef.current);
    }
  }, [view.activeMessageId, view.messages]);

  const replyActivities = useMemo<ReplyBarActivity[]>(() => {
    if (hideActivities) return [];
    const message = view.activeMessageId
      ? view.messages.find((item) => item.id === view.activeMessageId)
      : [...view.messages].reverse().find((item) => item.role === "assistant");
    return [...(message?.activities ?? [])];
  }, [hideActivities, view.activeMessageId, view.messages]);

  const cancelActivity = useCallback(
    (targetConversationId: string, turnId: string) => {
      platform?.cancelTurn?.(targetConversationId, turnId);
    },
    [platform],
  );

  const send = useCallback(
    async (
      text: string,
      attachments: ChatAttachment[],
      targetConversationId = conversationId,
      onAccepted?: () => void,
    ) => {
      if (!platform?.sendConversationMessage)
        throw new Error("本地 AI 服务未连接，请重启应用后重试");
      setSendError(undefined);
      setSendPending(true);
      thinkingSetRef.current = false;
      setThinkingMs(undefined);
      runStartRef.current = Date.now();
      cancelRequestedRef.current = false;
      activeConversationIdRef.current = targetConversationId;
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
        const accepted = await platform.sendConversationMessage({
          operation,
          conversationId: targetConversationId,
          request: { text, images },
        });
        if (!("status" in accepted) || accepted.status === "started") {
          await reconcileSnapshot(accepted.snapshot);
        }
        onAccepted?.();
        let turnId: string;
        if (!("status" in accepted) || accepted.status === "started") {
          turnId = accepted.turnId;
        } else {
          if (!platform.waitForConversationQueue) throw new Error("当前宿主未提供排队消息等待能力");
          const queued = await platform.waitForConversationQueue(
            targetConversationId,
            accepted.queueId,
          );
          if (queued.outcome !== "completed") {
            if (queued.outcome === "aborted") return "cancelled";
            throw new Error("模型请求失败");
          }
          if (!queued.turnId) throw new Error("排队消息未启动");
          turnId = queued.turnId;
        }
        if (cancelRequestedRef.current) cancelActivity(targetConversationId, turnId);
        const outcome = await waitForOutcome(turnId);
        if (outcome === "aborted") return "cancelled";
        const runError = getView().error;
        if (runError) throw new Error(runError);
        if (outcome === "failed") throw new Error("模型请求失败");
        return turnId;
      } catch (error) {
        // 链路断开由连接域统一提示；不要再把同一次失败渲染成模型错误。
        if (!isAgentServiceDisconnectedError(error)) {
          setSendError(error instanceof Error ? error.message : "发送失败");
        }
        throw error;
      } finally {
        setSendPending(false);
      }
    },
    [
      platform,
      operation,
      conversationId,
      view.messages,
      selectConversation,
      reconcileSnapshot,
      cancelActivity,
      waitForOutcome,
      getView,
    ],
  );

  const cancel = useCallback(() => {
    cancelRequestedRef.current = true;
    if (view.activeTurnId)
      platform?.cancelTurn?.(activeConversationIdRef.current, view.activeTurnId);
  }, [platform, view.activeTurnId]);

  const clearMessages = useCallback(() => {
    clear();
    setSendError(undefined);
    setThinkingMs(undefined);
    setHideActivities(false);
    lastActivityMessageIdRef.current = undefined;
  }, [clear]);

  return {
    activeTurnId: view.activeTurnId,
    activeMessageId: view.activeMessageId,
    cancel,
    clearMessages,
    contextCompaction: view.contextCompaction,
    contextCompactionBoundaries: view.contextCompactionBoundaries,
    contextUsage: view.contextUsage,
    contextPruning: view.contextPruning,
    reconcileSnapshot,
    messages: view.messages,
    replyError: sendError ?? view.error,
    replyPending: Boolean(view.activeTurnId || view.activeMessageId || sendPending),
    sendPending,
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
  return useAiConversation(platform, conversationId, "answer.send");
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
