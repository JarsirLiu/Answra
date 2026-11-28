/**
 * 面试演练/辅助共用的文本会话入口：固定会话、显式命令，按 snapshot 与事实帧恢复。
 * 不读音频、不持有 prompt；两个模式只通过 conversationId 与 bridge 方法区分。
 */
import {
  ActiveInterviewAssistConversationId,
  ActiveInterviewConversationId,
  type ConversationSnapshot,
  type DesktopBridge,
} from "@answra/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationViewMessage } from "../../app/conversationView";
import { useConversationView } from "../../app/useConversationView";
import { toUserFacingFailure, type UserFacingModelFailure } from "../../modelFailure";

export type InterviewTextChatMode = "rehearsal" | "assist";

export interface InterviewTextChatHandle {
  opening: boolean;
  messages: ConversationViewMessage[];
  activeTurnId?: string;
  activeMessageId?: string;
  error?: string;
  /** 错误是否需要登录/配置入口；只由共享失败码判定，不解析自然语言。 */
  needsSignIn: boolean;
  needsModelSetup: boolean;
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
  const [openFailure, setOpenFailure] = useState<UserFacingModelFailure>();
  const [sendFailure, setSendFailure] = useState<UserFacingModelFailure>();
  const [authNotice, setAuthNotice] = useState<string>();
  const [sendPending, setSendPending] = useState(false);
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
    setOpenFailure(undefined);
    setInitialSnapshot(undefined);
    const openChat =
      mode === "rehearsal" ? platform?.openInterviewRehearsal : platform?.openInterviewAssist;
    const fallback = mode === "rehearsal" ? "打开面试演练失败" : "打开面试辅助失败";
    if (!openChat) {
      setOpening(false);
      setOpenFailure(toUserFacingFailure(`当前版本不支持${fallback}`, fallback));
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
      setOpenFailure(toUserFacingFailure(error, fallback));
    } finally {
      if (generation === openGeneration.current) setOpening(false);
    }
  }, [applySnapshot, conversationId, mode, platform, selectConversation]);

  useEffect(() => {
    void open();
    return () => {
      openGeneration.current += 1;
      // 离开本模式（切换演练/辅助或关闭面板）必须立即停声，不能把上一模式的朗读留在后台。
      platform?.stopTts?.({ conversationId });
    };
  }, [open, platform, conversationId]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) throw new Error("请输入面试官的问题");
    const sendMessage =
      mode === "rehearsal"
        ? (value: string) => platform?.sendInterviewMessage?.(conversationId, value)
        : (value: string) => platform?.sendInterviewAssistMessage?.(value);
    if (!sendMessage) throw new Error("当前版本不支持发送面试消息");
    setSendPending(true);
    setSendFailure(undefined);
    setAuthNotice(undefined);
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
      setSendFailure(toUserFacingFailure(error, "发送失败"));
      throw error;
    } finally {
      setSendPending(false);
    }
  }, [conversationId, draft, getView, mode, platform, reconcileSnapshot, waitForOutcome]);

  const cancel = useCallback(() => {
    if (view.activeTurnId) platform?.cancelTurn?.(conversationId, view.activeTurnId);
    platform?.stopTts?.({ conversationId });
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

  const viewFailure = view.error ? toUserFacingFailure(view.error, "回复失败") : undefined;
  const failure = openFailure ?? sendFailure ?? viewFailure;
  return {
    opening,
    messages: view.messages,
    activeTurnId: view.activeTurnId,
    activeMessageId: view.activeMessageId,
    error:
      failure?.message ??
      (authNotice ? toUserFacingFailure(authNotice, "登录失败").message : undefined),
    needsSignIn: Boolean(authNotice || failure?.needsSignIn),
    needsModelSetup: Boolean(failure?.needsModelSetup),
    signIn,
    sendPending,
    draft,
    setDraft,
    send,
    cancel,
  };
}
