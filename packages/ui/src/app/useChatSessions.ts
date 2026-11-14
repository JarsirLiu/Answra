import {
  ActiveChatConversationId,
  type ConversationSessionSummary,
  type DesktopBridge,
} from "@answra/shared";
import { useCallback, useEffect, useState } from "react";

const ACTIVE_CHAT_STORAGE_KEY = "answra.chat.activeConversationId";

/** 桌面 chat 会话状态唯一 owner：active ID、历史列表与新建/恢复/删除。 */
export function useChatSessions(platform: DesktopBridge | undefined) {
  const [activeConversationId, setActiveConversationId] = useState(readStoredConversationId);
  const [sessions, setSessions] = useState<readonly ConversationSessionSummary[]>([]);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    if (!platform?.listConversationSessions) {
      setSessions([]);
      return;
    }
    try {
      const next = await platform.listConversationSessions({ scope: "conversation" });
      setSessions(next);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取会话历史失败");
    }
  }, [platform]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const select = useCallback((conversationId: string) => {
    setActiveConversationId(conversationId);
    try {
      globalThis.localStorage?.setItem(ACTIVE_CHAT_STORAGE_KEY, conversationId);
    } catch {
      // localStorage 不可用时只影响重启恢复，不阻断当前会话。
    }
  }, []);

  const newConversation = useCallback(async () => {
    if (!platform?.createConversation) throw new Error("当前宿主不支持新建会话");
    const conversationId = createChatConversationId();
    await platform.createConversation(conversationId);
    select(conversationId);
    await refresh();
    return conversationId;
  }, [platform, refresh, select]);

  const resumeConversation = useCallback(
    (conversationId: string) => {
      select(conversationId);
    },
    [select],
  );

  const deleteConversation = useCallback(
    async (conversationId: string) => {
      if (!platform?.deleteConversationSession) throw new Error("当前宿主不支持删除会话");
      await platform.deleteConversationSession(conversationId);
      if (conversationId === activeConversationId) {
        const next = createChatConversationId();
        await platform.createConversation?.(next);
        select(next);
      }
      await refresh();
    },
    [activeConversationId, platform, refresh, select],
  );

  return {
    activeConversationId,
    deleteConversation,
    error,
    newConversation,
    refresh,
    resumeConversation,
    sessions,
  };
}

function readStoredConversationId(): string {
  try {
    const stored = globalThis.localStorage?.getItem(ACTIVE_CHAT_STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // 读取失败时回到迁移会话。
  }
  return ActiveChatConversationId;
}

function createChatConversationId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `chat-${uuid ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}
