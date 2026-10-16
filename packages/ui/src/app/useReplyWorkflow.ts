import type {
  DesktopBridge,
  ReplyBarAction,
  ReplyBarActivity,
  ReplyBarState,
} from "@answra/shared";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import type { ChatAttachment } from "../components/panels/ChatPanel";
import type { ReplyPhase } from "../components/panels/ReplyBar";

interface UseReplyWorkflowOptions {
  platform: DesktopBridge | undefined;
  sendMessage: (
    text: string,
    attachments: ChatAttachment[],
    conversationId?: string,
  ) => Promise<string>;
  cancelMessage: () => void;
  replyText: string;
  replyActivities: ReplyBarActivity[];
  replyError?: string;
  replyPending?: boolean;
  replyConfigured?: boolean;
  phase: ReplyPhase | "closed";
  stealth: boolean;
  onWorkflowStart: () => void;
  onWorkflowFinish: () => void;
  onWorkflowPhase: (phase: ReplyPhase) => void;
  onCaptureError: (message: string) => void;
}

function readInkColor(): string | undefined {
  const probe = document.createElement("span");
  probe.style.color = "var(--ink)";
  probe.style.display = "none";
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color || undefined;
}

/** Owns screenshot attachments, draft state and the detached reply-bar bridge. */
export function useReplyWorkflow({
  platform,
  sendMessage,
  cancelMessage,
  replyText,
  replyActivities,
  replyError,
  replyPending,
  phase,
  stealth,
  onWorkflowStart,
  onWorkflowFinish,
  onWorkflowPhase,
  onCaptureError,
}: UseReplyWorkflowOptions) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replyWindowWasOpen = useRef(false);
  const actionHandler = useRef<(action: ReplyBarAction) => void>(() => undefined);
  const detachedReplyBar = typeof platform?.setReplyBarState === "function";

  const readReplyBarState = useCallback((): ReplyBarState => {
    const root = document.documentElement;
    const computed = getComputedStyle(root);
    const variables: Record<string, string> = {};
    for (let index = 0; index < computed.length; index += 1) {
      const name = computed.item(index);
      if (name.startsWith("--")) variables[name] = computed.getPropertyValue(name).trim();
    }
    variables["--fade"] = root.style.getPropertyValue("--fade") || "1";
    return {
      phase: phase === "streaming" ? "streaming" : phase === "done" ? "done" : "composing",
      ...(conversationId ? { conversationId } : {}),
      attachments,
      draft,
      replyText,
      replyActivities,
      ...(replyError ? { replyError } : {}),
      replyPending: phase === "done" ? false : (replyPending ?? phase === "streaming"),
      stealth,
      theme: { scheme: root.dataset.theme, variables },
    };
  }, [
    attachments,
    conversationId,
    draft,
    phase,
    replyActivities,
    replyError,
    replyPending,
    replyText,
    stealth,
  ]);

  useEffect(() => {
    if (!detachedReplyBar) return;
    if (phase === "closed") {
      if (replyWindowWasOpen.current) {
        platform?.setReplyBarState?.(null);
        replyWindowWasOpen.current = false;
      }
      return;
    }
    replyWindowWasOpen.current = true;
    platform?.setReplyBarState?.(readReplyBarState());
  }, [detachedReplyBar, phase, platform, readReplyBarState]);

  useEffect(() => {
    if (!detachedReplyBar || phase === "closed") return;
    const observer = new MutationObserver(() => platform?.setReplyBarState?.(readReplyBarState()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });
    return () => observer.disconnect();
  }, [detachedReplyBar, phase, platform, readReplyBarState]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const target = current.find((candidate) => candidate.id === id);
      if (target?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(target.previewUrl);
      return current.filter((candidate) => candidate.id !== id);
    });
  }, []);

  const handleAttachmentChange = useCallback(
    (input: ChangeEvent<HTMLInputElement> | File | null) => {
      const file = input instanceof File ? input : (input?.target.files?.[0] ?? null);
      if (!file?.type.startsWith("image/")) return;
      setAttachments((current) => [
        ...current,
        { id: crypto.randomUUID(), name: file.name, previewUrl: URL.createObjectURL(file) },
      ]);
    },
    [],
  );

  const clearPending = useCallback(() => {
    setAttachments((current) => {
      current.forEach((candidate) => {
        if (candidate.previewUrl.startsWith("blob:")) URL.revokeObjectURL(candidate.previewUrl);
      });
      return [];
    });
    setDraft("");
    setConversationId(undefined);
  }, []);

  const startRegionCapture = useCallback(
    async (startCapture: NonNullable<DesktopBridge["startRegionCapture"]>) => {
      console.log("[reply] 触发区域截图");
      try {
        const result = await startCapture({ line: readInkColor() });
        console.log("[reply] 截图结果:", result);
        if (result.ok === false) {
          if (result.reason !== "cancelled") onCaptureError(result.message ?? "截图失败，请重试");
          return;
        }
        onWorkflowStart();
        console.log("[reply] 进入回复条预备区，追加截图附件");
        setAttachments((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            name: `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
            previewUrl: result.dataUrl,
          },
        ]);
      } catch (error) {
        console.error("[reply] 截图桥调用异常:", error);
        onCaptureError("截图调用异常，请查看终端日志");
      }
    },
    [onCaptureError, onWorkflowStart],
  );

  const triggerScreenshot = useCallback(() => {
    const startCapture = platform?.startRegionCapture;
    if (startCapture) void startRegionCapture(startCapture);
    else {
      onWorkflowStart();
      window.setTimeout(() => fileInputRef.current?.click(), 0);
    }
  }, [onWorkflowStart, platform, startRegionCapture]);

  const closeReplyBar = useCallback(() => {
    // 发送条（composing）：收起发送条本身，结束工作流并恢复悬浮导航条。
    if (phase === "composing") {
      clearPending();
      onWorkflowFinish();
      return;
    }
    // 回复条（streaming / done）：收起回复条回到发送条，而不是直接回退到悬浮导航条。
    // 结束流式运行并清空本轮截图与草稿，让发送条以空白状态重新开始。
    if (phase === "streaming") cancelMessage();
    clearPending();
    onWorkflowPhase("composing");
  }, [cancelMessage, clearPending, onWorkflowFinish, onWorkflowPhase, phase]);

  const cancelReply = useCallback(() => {
    // 取消只退出当前回复态，保留独立回复窗口，让用户能继续截图发送。
    cancelMessage();
    setConversationId(undefined);
    onWorkflowPhase("composing");
  }, [cancelMessage, onWorkflowPhase]);

  const performSend = useCallback(async () => {
    const content = draft.trim();
    if (!content && attachments.length === 0) return;
    const nextConversationId = `screenshot-${crypto.randomUUID()}`;
    setConversationId(nextConversationId);
    onWorkflowPhase("streaming");
    try {
      const outcome = await sendMessage(content, attachments, nextConversationId);
      if (outcome === "cancelled") return;
    } catch (error) {
      console.error("[reply] model run failed", error);
      onWorkflowPhase("composing");
      return;
    }
    attachments.forEach((candidate) => {
      if (candidate.previewUrl.startsWith("blob:")) URL.revokeObjectURL(candidate.previewUrl);
    });
    setDraft("");
    setAttachments([]);
    // 保留 conversationId 与已完成回复，让回复条进入完成态：用户可继续查看答案、
    // 展开详细面板看思考过程，或自行收起回退到发送条。
    onWorkflowPhase("done");
  }, [attachments, draft, onWorkflowPhase, sendMessage]);

  actionHandler.current = (action) => {
    switch (action.type) {
      case "draft/change":
        setDraft(action.value);
        break;
      case "attachment/add":
        setAttachments((current) => [...current, action.attachment]);
        break;
      case "attachment/remove":
        removeAttachment(action.id);
        break;
      case "screenshot/start":
        triggerScreenshot();
        break;
      case "send":
        performSend();
        break;
      case "cancel":
        cancelReply();
        break;
      case "close":
        closeReplyBar();
        break;
    }
  };

  useEffect(() => {
    if (!detachedReplyBar) return;
    return platform?.onReplyBarAction?.((action) => actionHandler.current(action));
  }, [detachedReplyBar, platform]);

  return {
    attachments,
    draft,
    replyText,
    replyActivities,
    replyError,
    fileInputRef,
    detachedReplyBar,
    triggerScreenshot,
    handleAttachmentChange,
    removeAttachment,
    closeReplyBar,
    cancelReply,
    clearPending,
    performSend,
    setDraft,
    setAttachments,
  };
}
