import type { AgentConnectionState, ConversationSnapshot, DesktopBridge } from "@answra/shared";
import {
  ActiveChatConversationId,
  AUTH_REQUIRED_NOTICE,
  isAgentServiceDisconnectedError,
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
  connection?: AgentConnectionState;
  attachments: ChatAttachment[];
  draft: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onDraftChange: (draft: string) => void;
  onAttachmentChange: (event: ChangeEvent<HTMLInputElement> | File | null) => void;
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
  onAttachmentRemove: (id: string) => void;
  onConversationCleared: (conversationId: string) => Promise<ConversationSnapshot>;
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
  connection,
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
  useEffect(() => {
    if (connection?.status !== "reconnecting" && connection?.status !== "unavailable") return;
    // 链路已断：旧模型的错误不能再压在连接提示下面，清空本地失败与发送错误。
    setFailure(undefined);
    conversation.clearMessages();
  }, [connection?.status, conversation.clearMessages]);

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
    setFailure(undefined);
    void conversation
      .send(sentDraft, sentAttachments, undefined, () => {
        onDraftChange("");
        onAttachmentsChange([]);
      })
      .then(onSent)
      .catch((error: unknown) => {
        if (isAgentServiceDisconnectedError(error)) return;
        setFailure(
          isAuthRequiredError(error)
            ? { message: AUTH_REQUIRED_NOTICE, needsSignIn: true }
            : { message: error instanceof Error ? error.message : "发送失败", needsSignIn: false },
        );
      });
  }

  async function clearConversation(): Promise<void> {
    if (!bridge?.clearConversationMessages) return;
    try {
      const snapshot = await onConversationCleared(ActiveChatConversationId);
      conversation.clearMessages();
      await conversation.reconcileSnapshot(snapshot);
      setFailure(undefined);
    } catch {
      // FloatingBarApp has already shown the shared clear failure notice.
    }
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
      connection={connection}
      streaming={Boolean(conversation.activeRunId)}
      sending={conversation.sendPending && !conversation.activeRunId}
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
      onClear={bridge?.clearConversationMessages ? () => void clearConversation() : undefined}
      clearDisabledReason={
        conversation.activeRunId || conversation.sendPending
          ? "回复完成后才能清空"
          : conversation.messages.length === 0
            ? "暂无可清空的对话"
            : undefined
      }
    />
  );
}
