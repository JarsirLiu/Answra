import type { DesktopBridge } from "@answra/shared";
import {
  ActiveChatConversationId,
  AUTH_REQUIRED_NOTICE,
  isAuthRequiredError,
} from "@answra/shared";
import { type ChangeEvent, type RefObject, useEffect, useState } from "react";
import { type ChatAttachment, ChatPanel } from "../components/panels/ChatPanel";
import { useGeneralChat } from "./useConversationChat";

interface ChatFeaturePanelProps {
  visible: boolean;
  bridge: DesktopBridge | undefined;
  signedIn: boolean;
  stealth: boolean;
  attachments: ChatAttachment[];
  draft: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onDraftChange: (draft: string) => void;
  onAttachmentChange: (event: ChangeEvent<HTMLInputElement> | File | null) => void;
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
  onAttachmentRemove: (id: string) => void;
  onConversationCleared: (conversationId: string) => void;
  onClose: () => void;
  onVote: (vote: "up" | "down" | null) => void;
  onSent: () => void;
}

/** Owns general chat state so answer-profile composition can omit this feature module. */
export function ChatFeaturePanel({
  visible,
  bridge,
  signedIn,
  stealth,
  attachments,
  draft,
  fileInputRef,
  onDraftChange,
  onAttachmentChange,
  onAttachmentsChange,
  onAttachmentRemove,
  onConversationCleared,
  onClose,
  onVote,
  onSent,
}: ChatFeaturePanelProps) {
  const conversation = useGeneralChat(bridge, ActiveChatConversationId);
  const [failure, setFailure] = useState<{ message: string; needsSignIn: boolean }>();
  useEffect(() => {
    if (signedIn) setFailure(undefined);
  }, [signedIn]);

  function signIn(): void {
    const pending = bridge?.loginAccount?.();
    if (!pending) return;
    void pending
      .then((result) => {
        if (!result.opened) {
          setFailure({ message: result.error ?? "无法打开授权页", needsSignIn: true });
        }
      })
      .catch((error: unknown) => {
        setFailure({
          message: error instanceof Error ? error.message : "登录失败",
          needsSignIn: true,
        });
      });
  }

  function send(): void {
    const sentDraft = draft;
    const sentAttachments = attachments;
    onDraftChange("");
    onAttachmentsChange([]);
    setFailure(undefined);
    void conversation
      .send(sentDraft, sentAttachments)
      .then(onSent)
      .catch((error: unknown) => {
        onDraftChange(sentDraft);
        onAttachmentsChange(sentAttachments);
        setFailure(
          isAuthRequiredError(error)
            ? { message: AUTH_REQUIRED_NOTICE, needsSignIn: true }
            : { message: error instanceof Error ? error.message : "发送失败", needsSignIn: false },
        );
      });
  }

  const error = failure?.message ?? conversation.replyError;
  const needsSignIn = Boolean(failure?.needsSignIn) || isAuthRequiredError(conversation.replyError);
  if (!visible) return null;

  return (
    <ChatPanel
      bridge={bridge}
      stealth={stealth}
      attachments={attachments}
      draft={draft}
      error={error}
      fileInputRef={fileInputRef}
      streaming={Boolean(conversation.activeRunId)}
      retry={conversation.retry}
      thinkingMs={conversation.thinkingMs}
      messages={conversation.messages}
      onCancel={conversation.cancel}
      onAttachmentChange={onAttachmentChange}
      onAttachmentRemove={onAttachmentRemove}
      onClose={onClose}
      onDraftChange={onDraftChange}
      onSignIn={needsSignIn ? signIn : undefined}
      onVote={onVote}
      onSend={send}
      onClear={
        bridge?.clearConversationMessages
          ? () => onConversationCleared(ActiveChatConversationId)
          : undefined
      }
      clearDisabledReason={
        conversation.activeRunId
          ? "回复完成后才能清空"
          : conversation.messages.length === 0
            ? "暂无可清空的对话"
            : undefined
      }
    />
  );
}
