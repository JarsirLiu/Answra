import type { DesktopBridge, ReplyBarActivity } from "@answra/shared";
import type { RefObject } from "react";
import { useCallback, useEffect, useState } from "react";
import { useReplyConversation } from "../../app/useReplyConversation";
import type { ChatAttachment } from "./ChatPanel";
import { ReplyBar, type ReplyPhase } from "./ReplyBar";
import { ReplyConversationPopover } from "./ReplyConversationPopover";
import "./ReplySlot.css";

interface ReplySlotProps {
  phase: ReplyPhase;
  attachments: ChatAttachment[];
  draft: string;
  replyText: string;
  replyActivities: ReplyBarActivity[];
  replyError?: string;
  replyPending?: boolean;
  conversationId?: string;
  bridge?: DesktopBridge;
  stealth: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onAttachmentChange: (file: File | null) => void;
  onAttachmentRemove: (id: string) => void;
  onScreenshot: () => void;
  onSend: () => void;
  onClose: () => void;
  onCancel: () => void;
}

/**
 * 主窗口内联回复槽：发送条（composing）+ 回复条（streaming/done）+ 可展开的回复详情。
 * 复用 {@link ReplyBar} 与 {@link ReplyConversationPopover}，与独立回复窗口（ReplyBarWindowApp）
 * 共用子组件但容器独立。展开状态由本组件局部持有，不复用独立窗口的桥状态。
 */
export function ReplySlot({
  phase,
  attachments,
  draft,
  replyText,
  replyActivities,
  replyError,
  replyPending,
  conversationId,
  bridge,
  stealth,
  fileInputRef,
  onAttachmentChange,
  onAttachmentRemove,
  onScreenshot,
  onSend,
  onClose,
  onCancel,
}: ReplySlotProps) {
  const [expanded, setExpanded] = useState(false);
  const conversation = useReplyConversation(
    bridge,
    conversationId,
    phase === "streaming" || expanded,
  );

  // 回复条收起回到发送条时，折叠展开的对话面板，避免留给空白发送条。
  useEffect(() => {
    if (phase === "composing") setExpanded(false);
  }, [phase]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);

  return (
    <section className="reply-slot" data-expanded={expanded ? "true" : undefined}>
      <ReplyBar
        attachments={attachments}
        draft={draft}
        fileInputRef={fileInputRef}
        phase={phase}
        replyText={replyText}
        replyActivities={replyActivities}
        replyError={replyError}
        replyPending={replyPending}
        showConversationToggle
        conversationExpanded={expanded}
        onToggleConversation={toggleExpanded}
        onAttachmentChange={onAttachmentChange}
        onAttachmentRemove={onAttachmentRemove}
        onClose={onClose}
        onCancel={onCancel}
        onScreenshot={onScreenshot}
        onSend={onSend}
      />
      {expanded ? (
        <ReplyConversationPopover
          messages={conversation.messages}
          activeRunId={conversation.activeRunId}
          error={conversation.error}
          placement="below"
          stealth={stealth}
          bridge={bridge}
          conversationId={conversationId}
        />
      ) : null}
    </section>
  );
}
