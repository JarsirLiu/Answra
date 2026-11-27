/**
 * 面试演练/辅助共用的文本会话入口：固定会话、显式命令，按 snapshot 与事实帧恢复。
 * 不读音频、不持有 prompt；两个模式只通过 conversationId 与 bridge 方法区分。
 */
import {
  ActiveInterviewAssistConversationId,
  ActiveInterviewConversationId,
  AUTH_REQUIRED_NOTICE,
  type ConversationSnapshot,
  type DesktopBridge,
  isAuthRequiredError,
} from "@answra/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationViewMessage } from "../../app/conversationView";
import { useConversationView } from "../../app/useConversationView";

export type InterviewTextChatMode = "rehearsal" | "assist";

/** Electron IPC 会给错误套上 `Error invoking remote method ...: Error:` 外壳；只显示内层事实。 */
const IPC_ERROR_PREFIX = /^Error invoking remote method [^:]+:\s*(?:Error:\s*)?/u;

function toUserFacingError(error: unknown): string {
  if (isAuthRequiredError(error)) return AUTH_REQUIRED_NOTICE;
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(IPC_ERROR_PREFIX, "");
}

export interface InterviewTextChatHandle {
  opening: boolean;
  messages: ConversationViewMessage[];
  activeTurnId?: string;
  activeMessageId?: string;
  error?: string;
  /** 错误是否需要登录入口；只由共享失败码判定，不解析自然语言。 */
  needsSignIn: boolean;
  signIn: () => Promise<void>;
  sendPending: boolean;
  draft: string;
  setDraft: (value: string) => void;
  send: () => Promise<void>;
  cancel: () => void;
}

export function useInterviewTextChat(
  platform: DesktopBridge | undefined,
  mode: InterviewTextChatMode,
): InterviewTextChatHandle {
  const conversationId =
    mode === "rehearsal" ? ActiveInterviewConversationId : ActiveInterviewAssistConversationId;
  const [initialSnapshot, setInitialSnapshot] = useState<ConversationSnapshot>();
  const [opening, setOpening] = useState(true);
  const [openError, setOpenError] = useState<string>();
  const [sendPending, setSendPending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [authNotice, setAuthNotice] = useState<string>();
  const [draft, setDraft] = useState("");
  const openGeneration = useRef(0);

  const getSnapshot = useCallback(async () => {
    if (mode === "rehearsal") {
      if (!platform?.getInterviewRehearsalSnapshot) throw new Error("当前版本不支持面试演练");
      return platform.getInterviewRehearsalSnapshot();
    }
    if (!platform?.getInterviewAssistSnapshot) throw new Error("当前版本不支持面试辅助");
    return platform.getInterviewAssistSnapshot();
  }, [mode, platform]);

  const { view, selectConversation, applySnapshot, reconcileSnapshot, waitForOutcome, getView } =
    useConversationView(platform, initialSnapshot ? conversationId : undefined, {
      enabled: Boolean(initialSnapshot),
      create: false,
      getSnapshot,
    });

  const open = useCallback(async () => {
    const generation = ++openGeneration.current;
    setOpening(true);
    setOpenError(undefined);
    setInitialSnapshot(undefined);
    const openChat =
      mode === "rehearsal" ? platform?.openInterviewRehearsal : platform?.openInterviewAssist;
    if (!openChat) {
      setOpening(false);
      setOpenError(mode === "rehearsal" ? "当前版本不支持面试演练" : "当前版本不支持面试辅助");
      return;
    }
    try {
      const result = await openChat();
      if (generation !== openGeneration.current) return;
      setInitialSnapshot(result.snapshot);
      selectConversation(conversationId);
      applySnapshot(result.snapshot);
    } catch (error) {
      if (generation !== openGeneration.current) return;
      setOpenError(error instanceof Error ? error.message : "打开面试会话失败");
    } finally {
      if (generation === openGeneration.current) setOpening(false);
    }
  }, [applySnapshot, conversationId, mode, platform, selectConversation]);

  useEffect(() => {
    void open();
    return () => {
      openGeneration.current += 1;
    };
  }, [open]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) throw new Error("请输入面试官的问题");
    const sendMessage =
      mode === "rehearsal"
        ? (value: string) => platform?.sendInterviewMessage?.(conversationId, value)
        : (value: string) => platform?.sendInterviewAssistMessage?.(value);
    if (!sendMessage) throw new Error("当前版本不支持发送面试消息");
    setSendPending(true);
    setSendError(undefined);
    try {
      const accepted = await sendMessage(text);
      if (!accepted) throw new Error("当前版本不支持发送面试消息");
      setInitialSnapshot(accepted.snapshot);
      await reconcileSnapshot(accepted.snapshot);
      setDraft("");
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
  }, [conversationId, draft, getView, mode, platform, reconcileSnapshot, waitForOutcome]);

  const cancel = useCallback(() => {
    if (view.activeTurnId) platform?.cancelTurn?.(conversationId, view.activeTurnId);
  }, [conversationId, platform, view.activeTurnId]);

  const signIn = useCallback(async () => {
    setAuthNotice(undefined);
    try {
      const result = await platform?.loginAccount?.();
      if (result && !result.opened) setAuthNotice(result.error ?? "无法打开授权页");
    } catch (error) {
      setAuthNotice(error instanceof Error ? error.message : "登录失败");
    }
  }, [platform]);

  // 原始失败只用于判定登录入口；展示层拿到的永远是去掉 IPC 外壳的事实文案。
  const rawError = authNotice ?? openError ?? sendError ?? view.error;
  return {
    opening,
    messages: view.messages,
    activeTurnId: view.activeTurnId,
    activeMessageId: view.activeMessageId,
    error: rawError ? toUserFacingError(rawError) : undefined,
    needsSignIn: Boolean(authNotice) || isAuthRequiredError(rawError),
    signIn,
    sendPending,
    draft,
    setDraft,
    send,
    cancel,
  };
}
