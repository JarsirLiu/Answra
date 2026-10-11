import type { DesktopBridge, ReplyBarAction, ReplyBarState } from "@answra/shared";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import type { ChatAttachment } from "../components/panels/ChatPanel";
import type { ReplyPhase } from "../components/panels/ReplyBar";

const SCREENSHOT_PROMPT = "请帮我分析这道题，先说明题意和解题思路。";

interface UseReplyWorkflowOptions {
  platform: DesktopBridge | undefined;
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
  phase,
  stealth,
  onWorkflowStart,
  onWorkflowFinish,
  onWorkflowPhase,
  onCaptureError,
}: UseReplyWorkflowOptions) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [replyText, setReplyText] = useState("");
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
      phase: phase === "streaming" ? "streaming" : "composing",
      attachments,
      draft,
      replyText,
      stealth,
      theme: { scheme: root.dataset.theme, variables },
    };
  }, [attachments, draft, phase, replyText, stealth]);

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
      setDraft((current) => current || SCREENSHOT_PROMPT);
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
        setDraft((current) => current || SCREENSHOT_PROMPT);
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
    clearPending();
    onWorkflowFinish();
    setReplyText("");
  }, [clearPending, onWorkflowFinish]);

  const performSend = useCallback(() => {
    const content = draft.trim();
    if (!content && attachments.length === 0) return;
    attachments.forEach((candidate) => {
      if (candidate.previewUrl.startsWith("blob:")) URL.revokeObjectURL(candidate.previewUrl);
    });
    setReplyText(
      `演示回复：已收到${attachments.length ? ` ${attachments.length} 张截图` : ""}${content ? "与你的补充问题" : ""}。当前尚未连接 AI 服务；接入本地 API 后，这条横条会以匀速滚动的方式显示实际分析结果。`,
    );
    onWorkflowPhase("streaming");
    setDraft("");
    setAttachments([]);
  }, [attachments, draft, onWorkflowPhase]);

  actionHandler.current = (action) => {
    switch (action.type) {
      case "draft/change":
        setDraft(action.value);
        break;
      case "attachment/add":
        setAttachments((current) => [...current, action.attachment]);
        setDraft((current) => current || SCREENSHOT_PROMPT);
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
    fileInputRef,
    detachedReplyBar,
    triggerScreenshot,
    handleAttachmentChange,
    removeAttachment,
    closeReplyBar,
    performSend,
    setDraft,
  };
}
