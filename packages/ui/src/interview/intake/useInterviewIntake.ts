/** Interview intake 的唯一 renderer 状态入口：打开固定会话、发送文本/图片并以 snapshot/事实帧为准。 */
import type { ConversationSnapshot, DesktopBridge } from "@answra/shared";
import { ActiveInterviewIntakeConversationId } from "@answra/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { attachmentToImage, createAttachment, revokeAttachment } from "../../app/attachments";
import type { ConversationViewMessage } from "../../app/conversationView";
import { useConversationView } from "../../app/useConversationView";
import type { ChatAttachment } from "../../components/panels/ChatPanel";

export interface InterviewIntakeHandle {
  opening: boolean;
  messages: ConversationViewMessage[];
  activeTurnId?: string;
  activeMessageId?: string;
  error?: string;
  sendPending: boolean;
  draft: string;
  setDraft: (value: string) => void;
  attachments: ChatAttachment[];
  addAttachment: (file: File) => void;
  removeAttachment: (id: string) => void;
  send: () => Promise<void>;
  cancel: () => void;
  retryOpen: () => void;
}

export function useInterviewIntake(platform: DesktopBridge | undefined): InterviewIntakeHandle {
  const [initialSnapshot, setInitialSnapshot] = useState<ConversationSnapshot>();
  const [opening, setOpening] = useState(true);
  const [openError, setOpenError] = useState<string>();
  const [sendPending, setSendPending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const openGeneration = useRef(0);

  const getSnapshot = useCallback(async () => {
    if (!initialSnapshot) throw new Error("面试对话尚未打开");
    return initialSnapshot;
  }, [initialSnapshot]);
  const { view, selectConversation, applySnapshot, reconcileSnapshot, waitForOutcome, getView } =
    useConversationView(
      platform,
      initialSnapshot ? ActiveInterviewIntakeConversationId : undefined,
      { enabled: Boolean(initialSnapshot), create: false, getSnapshot },
    );

  const open = useCallback(async () => {
    const generation = ++openGeneration.current;
    setOpening(true);
    setOpenError(undefined);
    setInitialSnapshot(undefined);
    if (!platform?.openInterviewIntake) {
      setOpening(false);
      setOpenError("当前版本不支持面试对话");
      return;
    }
    try {
      const result = await platform.openInterviewIntake();
      if (generation !== openGeneration.current) return;
      setInitialSnapshot(result.snapshot);
      selectConversation(ActiveInterviewIntakeConversationId);
      applySnapshot(result.snapshot);
    } catch (error) {
      if (generation !== openGeneration.current) return;
      setOpenError(error instanceof Error ? error.message : "打开面试对话失败");
    } finally {
      if (generation === openGeneration.current) setOpening(false);
    }
  }, [platform, selectConversation, applySnapshot]);

  useEffect(() => {
    void open();
    return () => {
      openGeneration.current += 1;
    };
  }, [open]);

  // 关闭面板时释放未发送的预览对象 URL；发送成功时由 send 主动清空。
  useEffect(
    () => () => {
      attachmentsRef.current.forEach(revokeAttachment);
    },
    [],
  );

  const addAttachment = useCallback((file: File) => {
    const attachment = createAttachment(file);
    if (!attachment) return;
    setAttachments((current) => [...current, attachment]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const target = current.find((candidate) => candidate.id === id);
      if (target) revokeAttachment(target);
      return current.filter((candidate) => candidate.id !== id);
    });
  }, []);

  const send = useCallback(async () => {
    if (!platform?.sendInterviewIntakeMessage) throw new Error("当前版本不支持面试对话");
    const text = draft.trim();
    if (!text && attachments.length === 0) throw new Error("请输入内容或添加图片");
    setSendPending(true);
    setSendError(undefined);
    try {
      const images = await Promise.all(attachments.map(attachmentToImage));
      const accepted = await platform.sendInterviewIntakeMessage(text, images);
      setInitialSnapshot(accepted.snapshot);
      await reconcileSnapshot(accepted.snapshot);
      setDraft("");
      setAttachments((current) => {
        current.forEach(revokeAttachment);
        return [];
      });
      const outcome = await waitForOutcome(accepted.turnId);
      if (outcome === "aborted") return;
      const runError = getView().error;
      if (runError) throw new Error(runError);
      if (outcome === "failed") throw new Error("模型请求失败");
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "发送失败");
      throw error;
    } finally {
      setSendPending(false);
    }
  }, [attachments, draft, platform, reconcileSnapshot, waitForOutcome, getView]);

  const cancel = useCallback(() => {
    if (view.activeTurnId)
      platform?.cancelTurn?.(ActiveInterviewIntakeConversationId, view.activeTurnId);
  }, [platform, view.activeTurnId]);

  const retryOpen = useCallback(() => {
    void open();
  }, [open]);

  return {
    opening,
    messages: view.messages,
    activeTurnId: view.activeTurnId,
    activeMessageId: view.activeMessageId,
    error: openError ?? sendError ?? view.error,
    sendPending,
    draft,
    setDraft,
    attachments,
    addAttachment,
    removeAttachment,
    send,
    cancel,
    retryOpen,
  };
}
