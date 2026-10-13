import type {
  DesktopBridge,
  ReplyBarAction,
  ReplyBarPlacement,
  ReplyBarState,
} from "@answra/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ReplyBar } from "../components/panels/ReplyBar";
import { ReplyConversationPopover } from "../components/panels/ReplyConversationPopover";
import { useFitContent } from "../hooks/useFitContent";
import { useReplyConversation } from "./useReplyConversation";

interface ReplyBarWindowAppProps {
  bridge?: DesktopBridge;
}

/** Independent renderer for the task workflow; the toolbar renderer owns state. */
export function ReplyBarWindowApp({ bridge }: ReplyBarWindowAppProps) {
  const platform = bridge ?? (globalThis as { answra?: DesktopBridge }).answra;
  const [state, setState] = useState<ReplyBarState | null>(null);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [placement, setPlacement] = useState<ReplyBarPlacement>("above");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const expanded = !dismissed && (hovered || pinned);
  const measureBridge = platform?.fitReplyBar ? { fitContent: platform.fitReplyBar } : undefined;
  const { ref } = useFitContent(measureBridge);
  const conversation = useReplyConversation(
    platform,
    state?.conversationId,
    Boolean(state && (state.phase === "streaming" || expanded)),
  );
  const togglePinned = useCallback(() => {
    if (pinned) {
      setPinned(false);
      setHovered(false);
      setDismissed(true);
    } else {
      setDismissed(false);
      setPinned(true);
    }
  }, [pinned]);

  useEffect(() => {
    const unsubscribe = platform?.onReplyBarState?.(setState);
    const unsubscribePlacement = platform?.onReplyBarPlacement?.(setPlacement);
    platform?.requestReplyBarState?.();
    return () => {
      unsubscribe?.();
      unsubscribePlacement?.();
    };
  }, [platform]);

  useEffect(() => {
    if (!state) return;
    const root = document.documentElement;
    root.dataset.theme = state.theme.scheme ?? "light";
    for (const [name, value] of Object.entries(state.theme.variables)) {
      root.style.setProperty(name, value);
    }
    root.style.setProperty("--fade", state.theme.variables["--fade"] ?? "1");
  }, [state]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPinned(false);
      setHovered(false);
      setDismissed(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  if (!state) return <main aria-hidden="true" className="reply-window-root" ref={ref} />;

  const send = (action: ReplyBarAction) => platform?.sendReplyBarAction?.(action);

  const replyBar = (
    <ReplyBar
      attachments={state.attachments}
      draft={state.draft}
      fileInputRef={fileInputRef}
      phase={state.phase}
      replyText={state.replyText}
      replyActivities={state.replyActivities ?? []}
      replyError={state.replyError}
      replyPending={state.replyPending}
      showConversationToggle
      conversationExpanded={expanded}
      conversationPinned={pinned}
      onConversationHover={() => {
        if (!dismissed) setHovered(true);
      }}
      onToggleConversation={togglePinned}
      onAttachmentChange={(file) => {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === "string") {
            send({
              type: "attachment/add",
              attachment: {
                id: crypto.randomUUID(),
                name: file.name,
                previewUrl: reader.result,
              },
            });
          }
        };
        reader.readAsDataURL(file);
      }}
      onAttachmentRemove={(id) => send({ type: "attachment/remove", id })}
      onClose={() => send({ type: "close" })}
      onCancel={() => send({ type: "cancel" })}
      onScreenshot={() => send({ type: "screenshot/start" })}
      onSend={() => send({ type: "send" })}
    />
  );
  const popover = expanded ? (
    <ReplyConversationPopover
      activeRunId={conversation.activeRunId}
      error={conversation.error}
      messages={conversation.messages}
      placement={placement}
      stealth={state.stealth}
    />
  ) : null;

  return (
    <main
      className="reply-window-root"
      data-stealth={state.stealth ? "true" : undefined}
      data-expanded={expanded ? "true" : undefined}
      data-placement={placement}
      onMouseLeave={() => {
        setHovered(false);
        setDismissed(false);
      }}
      ref={ref}
    >
      {placement === "above" ? (
        <>
          {popover}
          {replyBar}
        </>
      ) : (
        <>
          {replyBar}
          {popover}
        </>
      )}
    </main>
  );
}
