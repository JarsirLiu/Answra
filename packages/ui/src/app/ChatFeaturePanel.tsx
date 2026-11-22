import type { AgentConnectionState, ConversationSnapshot, DesktopBridge } from "@answra/shared";
import {
  AUTH_REQUIRED_NOTICE,
  isAgentServiceDisconnectedError,
  isAuthRequiredError,
} from "@answra/shared";
import { type ChangeEvent, type RefObject, useEffect, useState } from "react";
import { AGENT_SERVICE_UNAVAILABLE_NOTICE } from "../components/chat";
import { type ChatAttachment, ChatPanel } from "../components/panels/ChatPanel";
import { useChatSessions } from "./useChatSessions";
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
  const sessions = useChatSessions(bridge);
  const conversation = useGeneralChat(bridge, sessions.activeConversationId);
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
        if (isAgentServiceDisconnectedError(error)) {
          setFailure({ message: AGENT_SERVICE_UNAVAILABLE_NOTICE, needsSignIn: false });
          return;
        }
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
      const snapshot = await onConversationCleared(sessions.activeConversationId);
      conversation.clearMessages();
      await conversation.reconcileSnapshot(snapshot);
      setFailure(undefined);
    } catch {
      // FloatingBarApp has already shown the shared clear failure notice.
    }
  }

  async function startNewConversation(): Promise<void> {
    if (conversation.replyPending) return;
    setFailure(undefined);
    try {
      await sessions.newConversation();
      conversation.clearMessages();
    } catch (cause) {
      setFailure({
        message: cause instanceof Error ? cause.message : "新建会话失败",
        needsSignIn: false,
      });
    }
  }

  function resumeConversation(conversationId: string): void {
    if (conversation.replyPending) return;
    setFailure(undefined);
    conversation.clearMessages();
    sessions.resumeConversation(conversationId);
  }

  async function deleteConversation(conversationId: string): Promise<void> {
    if (conversation.replyPending) return;
    setFailure(undefined);
    const wasActive = conversationId === sessions.activeConversationId;
    try {
      await sessions.deleteConversation(conversationId);
      if (wasActive) conversation.clearMessages();
    } catch (cause) {
      setFailure({
        message: cause instanceof Error ? cause.message : "删除会话失败",
        needsSignIn: false,
      });
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
      contextCompaction={conversation.contextCompaction}
      compactionBoundaries={conversation.contextCompactionBoundaries}
      streaming={Boolean(conversation.activeMessageId)}
      sending={conversation.sendPending && !conversation.activeMessageId}
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
        conversation.replyPending
          ? "回复完成后才能清空"
          : conversation.messages.length === 0
            ? "暂无可清空的对话"
            : undefined
      }
      sessions={sessions.sessions}
      activeConversationId={sessions.activeConversationId}
      historyError={sessions.error}
      historyDisabledReason={conversation.replyPending ? "回复完成后才能切换会话" : undefined}
      historyHasMore={sessions.hasMore}
      historyLoading={sessions.loadingMore}
      onLoadMoreHistory={() => void sessions.loadMore()}
      onNewConversation={() => void startNewConversation()}
      onResumeConversation={resumeConversation}
      onDeleteConversation={deleteConversation}
    />
  );
}
