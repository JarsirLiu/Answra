/** Interview intake 的唯一 renderer 状态入口：打开固定会话、发送文本并以 snapshot/事件为准。 */
import type { ConversationSnapshot, DesktopBridge } from "@answra/shared";
import { ActiveInterviewIntakeConversationId } from "@answra/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationViewMessage } from "../../app/conversationView";
import { useConversationView } from "../../app/useConversationView";

export interface InterviewIntakeHandle {
  opening: boolean;
  messages: ConversationViewMessage[];
  activeRunId?: string;
  error?: string;
  sendPending: boolean;
  draft: string;
  setDraft: (value: string) => void;
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
  const openGeneration = useRef(0);

  const getSnapshot = useCallback(async () => {
    if (!initialSnapshot) throw new Error("面试对话尚未打开");
    return initialSnapshot;
  }, [initialSnapshot]);
  const readEvents = useCallback(
    (_conversationId: string, afterRevision: number) =>
      platform?.readInterviewIntakeEvents?.(afterRevision) ?? Promise.resolve([]),
    [platform],
  );
  const { view, selectConversation, applySnapshot, reconcileRunSnapshot, waitForRun, getView } =
    useConversationView(
      platform,
      initialSnapshot ? ActiveInterviewIntakeConversationId : undefined,
      {
        enabled: Boolean(initialSnapshot),
        create: false,
        getSnapshot,
        readEvents,
      },
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

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !platform?.sendInterviewIntakeMessage) throw new Error("当前版本不支持面试对话");
    setSendPending(true);
    setSendError(undefined);
    try {
      const accepted = await platform.sendInterviewIntakeMessage(text);
      setInitialSnapshot(accepted.snapshot);
      await reconcileRunSnapshot(accepted.snapshot);
      setDraft("");
      const outcome = await waitForRun(accepted.runId);
      if (outcome === "aborted" || outcome === "superseded") return;
      const runError = getView().error;
      if (runError) throw new Error(runError);
      if (outcome === "failed") throw new Error("模型请求失败");
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "发送失败");
      throw error;
    } finally {
      setSendPending(false);
    }
  }, [draft, platform, reconcileRunSnapshot, waitForRun, getView]);

  const cancel = useCallback(() => {
    if (view.activeRunId) platform?.cancelConversationRun?.(view.activeRunId);
  }, [platform, view.activeRunId]);

  const retryOpen = useCallback(() => {
    void open();
  }, [open]);

  return {
    opening,
    messages: view.messages,
    activeRunId: view.activeRunId,
    error: openError ?? sendError ?? view.error,
    sendPending,
    draft,
    setDraft,
    send,
    cancel,
    retryOpen,
  };
}
