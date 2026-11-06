import type { ConversationChange, DesktopBridge } from "@answra/shared";
import type { RunOutcome } from "@answra/shared/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyConversationChange,
  applyHistoricalConversationEvent,
  type ConversationProjectionOptions,
  type ConversationView,
  conversationChangeRevision,
  conversationOf,
  EMPTY_CONVERSATION_VIEW,
} from "./conversationView";

export interface UseConversationViewOptions extends ConversationProjectionOptions {
  enabled?: boolean;
  /** 会话不存在时是否创建（对话/面试需要；回复详情只读快照）。 */
  create?: boolean;
}

export interface ConversationViewHandle {
  view: ConversationView;
  /** 切换当前订阅的会话；同步更新活动会话，避免发送与事件到达之间丢首帧。 */
  selectConversation: (conversationId: string | undefined) => void;
  waitForRun: (runId: string) => Promise<RunOutcome>;
  /** 读取最新投影（发送完成时判断本轮是否带流式错误）。 */
  getView: () => ConversationView;
  /** 只清空本地渲染内容，保留 revision 游标以继续接收同一会话的新事件。 */
  clear: () => void;
}

/**
 * 唯一的前端会话投影入口：订阅 ConversationChange，折叠成 ConversationView。
 * 对话、面试、回复详情都走这里，不再各自维护 reducer。
 */
export function useConversationView(
  platform: DesktopBridge | undefined,
  conversationId: string | undefined,
  options: UseConversationViewOptions = {},
): ConversationViewHandle {
  const { enabled = true, create = true } = options;
  const [activeId, setActiveId] = useState(conversationId);
  const [view, setView] = useState<ConversationView>(EMPTY_CONVERSATION_VIEW);
  const activeIdRef = useRef(conversationId);
  const propIdRef = useRef(conversationId);
  const viewRef = useRef(view);
  const optionsRef = useRef(options);
  const readyRef = useRef(false);
  const queueRef = useRef<ConversationChange[]>([]);
  const generationRef = useRef(0);
  const processingRef = useRef<Promise<void>>(Promise.resolve());
  const waitersRef = useRef(new Map<string, (outcome: RunOutcome) => void>());
  const finishedRef = useRef(new Map<string, RunOutcome>());
  optionsRef.current = options;

  const commit = useCallback((change: ConversationChange) => {
    const id = activeIdRef.current;
    if (!id) return;
    const next = applyConversationChange(viewRef.current, change, id, optionsRef.current);
    if (next === viewRef.current) return;
    viewRef.current = next;
    setView(next);
  }, []);

  const setViewError = useCallback((message: string) => {
    const next = { ...viewRef.current, error: message };
    viewRef.current = next;
    setView(next);
  }, []);

  const settle = useCallback((runId: string, outcome: RunOutcome) => {
    const waiter = waitersRef.current.get(runId);
    if (waiter) {
      waitersRef.current.delete(runId);
      waiter(outcome);
      return;
    }
    finishedRef.current.set(runId, outcome);
    if (finishedRef.current.size > 16) {
      const oldest = finishedRef.current.keys().next().value;
      if (oldest !== undefined) finishedRef.current.delete(oldest);
    }
  }, []);

  const applyWithRecovery = useCallback(
    async (change: ConversationChange) => {
      const id = activeIdRef.current;
      if (!id || conversationOf(change) !== id) return;
      const generation = generationRef.current;
      if (change.type === "run-finished") settle(change.runId, change.outcome);
      const revision = conversationChangeRevision(change);
      if (revision <= viewRef.current.revision) return;
      if (revision > viewRef.current.revision + 1 && platform?.readConversationEvents) {
        const missing = await platform.readConversationEvents(id, viewRef.current.revision);
        if (generation !== generationRef.current) return;
        for (const recovered of missing) {
          if (generation !== generationRef.current) return;
          if (conversationOf(recovered) !== id) continue;
          if (conversationChangeRevision(recovered) <= viewRef.current.revision) {
            const next = applyHistoricalConversationEvent(
              viewRef.current,
              recovered,
              id,
              optionsRef.current,
            );
            if (next !== viewRef.current) {
              viewRef.current = next;
              setView(next);
            }
          } else {
            commit(recovered);
          }
        }
        if (revision > viewRef.current.revision + 1 && platform?.getConversationSnapshot) {
          const latest = await platform.getConversationSnapshot(id);
          if (generation !== generationRef.current) return;
          commit({ type: "snapshot", snapshot: latest });
        }
      }
      commit(change);
    },
    [platform, commit, settle],
  );

  const enqueue = useCallback(
    (change: ConversationChange) => {
      processingRef.current = processingRef.current
        .then(() => applyWithRecovery(change))
        .catch((error: unknown) => {
          setViewError(errorMessage(error));
        });
    },
    [applyWithRecovery, setViewError],
  );

  const selectConversation = useCallback((id: string | undefined) => {
    if (activeIdRef.current === id) return;
    activeIdRef.current = id;
    generationRef.current += 1;
    readyRef.current = false;
    queueRef.current = [];
    processingRef.current = Promise.resolve();
    waitersRef.current.clear();
    finishedRef.current.clear();
    viewRef.current = EMPTY_CONVERSATION_VIEW;
    setView(EMPTY_CONVERSATION_VIEW);
    setActiveId(id);
  }, []);

  useEffect(() => {
    if (propIdRef.current === conversationId) return;
    propIdRef.current = conversationId;
    selectConversation(conversationId);
  }, [conversationId, selectConversation]);

  useEffect(() => {
    if (!enabled || !platform?.onConversationChange) return;
    return platform.onConversationChange((change) => {
      const id = activeIdRef.current;
      if (!id || conversationOf(change) !== id) return;
      if (!readyRef.current) {
        queueRef.current.push(change);
        return;
      }
      enqueue(change);
    });
  }, [enabled, platform, enqueue]);

  useEffect(() => {
    if (!enabled || !activeId) return;
    const id = activeId;
    const generation = ++generationRef.current;
    readyRef.current = false;
    const getSnapshot =
      create && platform?.createConversation
        ? () => platform.createConversation?.(id)
        : platform?.getConversationSnapshot
          ? () => platform.getConversationSnapshot?.(id)
          : undefined;
    if (!getSnapshot) {
      readyRef.current = true;
      return;
    }
    let cancelled = false;
    const initialize = async () => {
      try {
        const snapshot = await getSnapshot();
        if (!snapshot || cancelled || generation !== generationRef.current) return;
        commit({ type: "snapshot", snapshot });
        if (platform?.readConversationEvents) {
          const history = await platform.readConversationEvents(id, 0);
          if (cancelled || generation !== generationRef.current) return;
          const later: ConversationChange[] = [];
          for (const change of history) {
            if (conversationOf(change) !== id) continue;
            if (conversationChangeRevision(change) <= viewRef.current.revision) {
              const next = applyHistoricalConversationEvent(
                viewRef.current,
                change,
                id,
                optionsRef.current,
              );
              if (next !== viewRef.current) {
                viewRef.current = next;
                setView(next);
              }
            } else {
              later.push(change);
            }
          }
          readyRef.current = true;
          const pending = [...later, ...queueRef.current].sort(
            (left, right) => conversationChangeRevision(left) - conversationChangeRevision(right),
          );
          queueRef.current = [];
          for (const change of pending) enqueue(change);
        } else {
          readyRef.current = true;
          const pending = queueRef.current.splice(0);
          for (const change of pending) enqueue(change);
        }
      } catch (error) {
        if (cancelled || generation !== generationRef.current) return;
        readyRef.current = true;
        setViewError(errorMessage(error));
        const pending = queueRef.current.splice(0);
        for (const change of pending) enqueue(change);
      }
    };
    void initialize();
    return () => {
      cancelled = true;
    };
  }, [activeId, create, enabled, platform, commit, enqueue, setViewError]);

  const waitForRun = useCallback((runId: string) => {
    const done = finishedRef.current.get(runId);
    if (done) {
      finishedRef.current.delete(runId);
      return Promise.resolve(done);
    }
    return new Promise<RunOutcome>((resolve) => {
      waitersRef.current.set(runId, resolve);
    });
  }, []);

  const clear = useCallback(() => {
    const next = {
      ...viewRef.current,
      messages: [],
      activeRunId: undefined,
      retry: undefined,
      error: undefined,
    };
    viewRef.current = next;
    setView(next);
  }, []);

  const getView = useCallback(() => viewRef.current, []);

  return { view, selectConversation, waitForRun, getView, clear };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "读取对话失败";
}
