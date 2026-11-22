/**
 * 会话视图的唯一游标与折叠入口。
 *
 * 会话与 Answer 共用同一条事实通道：`SessionFrame`（durable，按 `seq` 重放）
 * 与 `LiveFrame`（可丢增量），不再保留旧 envelope 分支。
 */
import type { ConversationSnapshot, DesktopBridge, LiveFrame, SessionFrame } from "@answra/shared";
import type { TurnOutcome } from "@answra/shared/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyConversationSnapshot,
  type ConversationProjectionOptions,
  type ConversationView,
  EMPTY_CONVERSATION_VIEW,
  foldConversationFrame,
  overlayLiveFrame,
} from "./conversationView";

export interface UseConversationViewOptions extends ConversationProjectionOptions {
  enabled?: boolean;
  create?: boolean;
  /** 领域自己的权威快照读取；缺省走通用 conversation bridge。 */
  getSnapshot?: (conversationId: string) => Promise<ConversationSnapshot>;
}

export interface ConversationViewHandle {
  view: ConversationView;
  selectConversation: (conversationId: string | undefined) => void;
  applySnapshot: (snapshot: ConversationSnapshot) => void;
  reconcileSnapshot: (snapshot: ConversationSnapshot) => Promise<void>;
  /** 等待一次活动结束：只用 Turn id，终态只认 `turn-finished`。 */
  waitForOutcome: (turnId: string) => Promise<TurnOutcome>;
  getView: () => ConversationView;
  clear: () => void;
}

export function useConversationView(
  platform: DesktopBridge | undefined,
  conversationId: string | undefined,
  options: UseConversationViewOptions = {},
): ConversationViewHandle {
  const { enabled = true, create = true } = options;
  const [activeId, setActiveId] = useState(conversationId);
  const [view, setView] = useState(EMPTY_CONVERSATION_VIEW);
  const activeIdRef = useRef(conversationId);
  const viewRef = useRef(view);
  const optionsRef = useRef(options);
  const generationRef = useRef(0);
  const waitersRef = useRef(new Map<string, (outcome: TurnOutcome) => void>());
  const finishedRef = useRef(new Map<string, TurnOutcome>());
  const syncingRef = useRef(false);
  const resyncRef = useRef(false);
  const initializingRef = useRef(false);
  optionsRef.current = options;

  const resolveOutcome = useCallback((turnId: string, outcome: TurnOutcome) => {
    const waiter = waitersRef.current.get(turnId);
    if (waiter !== undefined) {
      waitersRef.current.delete(turnId);
      waiter(outcome);
      return;
    }
    finishedRef.current.set(turnId, outcome);
  }, []);

  /** 折叠一条本会话帧；返回 false 表示游标有缺口，调用方必须整段重读。 */
  const applySequential = useCallback(
    (frame: SessionFrame): boolean => {
      const current = viewRef.current;
      if (frame.sessionId !== activeIdRef.current) return true;
      if (frame.seq <= current.lastSeq) return true;
      if (frame.seq !== current.lastSeq + 1) return false;
      const terminal = turnOutcomeOf(frame);
      if (terminal !== undefined) resolveOutcome(terminal.turnId, terminal.outcome);
      const next = foldConversationFrame(current, frame, optionsRef.current);
      if (next === current) return true;
      viewRef.current = next;
      setView(next);
      return true;
    },
    [resolveOutcome],
  );

  const readAfter = useCallback(
    async (id: string, cursor: number): Promise<SessionFrame[]> =>
      (await platform?.readSessionFrames?.(id, cursor)) ?? [],
    [platform],
  );

  /** 按当前游标整段重读，直到缺口标记清零；失败只留标记，由下一次到达触发重试。 */
  const syncCursor = useCallback(async () => {
    if (syncingRef.current || initializingRef.current || !activeIdRef.current) return;
    syncingRef.current = true;
    const generation = generationRef.current;
    const id = activeIdRef.current;
    try {
      while (resyncRef.current) {
        resyncRef.current = false;
        const frames = await readAfter(id, viewRef.current.lastSeq);
        if (generation !== generationRef.current || activeIdRef.current !== id) return;
        for (const frame of frames) {
          if (!applySequential(frame)) resyncRef.current = true;
        }
      }
    } catch (error) {
      resyncRef.current = true;
      console.error("[conversation-view] failed to sync session frames", error);
    } finally {
      syncingRef.current = false;
    }
  }, [applySequential, readAfter]);

  const receive = useCallback(
    (frame: SessionFrame) => {
      if (!activeIdRef.current || frame.sessionId !== activeIdRef.current) return;
      if (initializingRef.current) {
        resyncRef.current = true;
        return;
      }
      if (!applySequential(frame)) resyncRef.current = true;
      if (resyncRef.current) void syncCursor();
    },
    [applySequential, syncCursor],
  );
  const receiveLive = useCallback((frame: LiveFrame) => {
    if (!activeIdRef.current || frame.sessionId !== activeIdRef.current) return;
    const next: ConversationView = overlayLiveFrame(viewRef.current, frame, optionsRef.current);
    if (next === viewRef.current) return;
    viewRef.current = next;
    setView(next);
  }, []);

  const isStaleSnapshot = useCallback(
    (snapshot: ConversationSnapshot) => snapshot.lastSeq < viewRef.current.lastSeq,
    [],
  );

  const commitSnapshot = useCallback(
    (snapshot: ConversationSnapshot, invalidateInitialization: boolean): boolean => {
      if (activeIdRef.current !== snapshot.conversationId) return false;
      if (isStaleSnapshot(snapshot)) return false;
      if (invalidateInitialization) {
        generationRef.current += 1;
        initializingRef.current = false;
      }
      const next = applyConversationSnapshot(viewRef.current, snapshot, optionsRef.current);
      viewRef.current = next;
      setView(next);
      return true;
    },
    [isStaleSnapshot],
  );
  const applySnapshot = useCallback(
    (snapshot: ConversationSnapshot) => {
      if (!commitSnapshot(snapshot, true)) return;
      resyncRef.current = true;
      void syncCursor();
    },
    [commitSnapshot, syncCursor],
  );
  const reconcileSnapshot = useCallback(
    async (snapshot: ConversationSnapshot) => {
      if (activeIdRef.current !== snapshot.conversationId) return;
      if (isStaleSnapshot(snapshot)) return;
      const generation = ++generationRef.current;
      initializingRef.current = true;
      resyncRef.current = false;
      const next = applyConversationSnapshot(viewRef.current, snapshot, optionsRef.current);
      viewRef.current = next;
      setView(next);
      try {
        const frames = await readAfter(snapshot.conversationId, next.lastSeq);
        if (generation !== generationRef.current) return;
        for (const frame of frames) {
          if (!applySequential(frame)) resyncRef.current = true;
        }
      } finally {
        if (generation === generationRef.current) {
          initializingRef.current = false;
          if (resyncRef.current) void syncCursor();
        }
      }
    },
    [applySequential, isStaleSnapshot, readAfter, syncCursor],
  );
  const receiveSnapshot = useCallback(
    (snapshot: ConversationSnapshot) => {
      void reconcileSnapshot(snapshot).catch((error: unknown) => {
        console.error("[conversation-view] failed to recover snapshot frames", error);
      });
    },
    [reconcileSnapshot],
  );

  const selectConversation = useCallback((id: string | undefined) => {
    activeIdRef.current = id;
    generationRef.current += 1;
    resyncRef.current = false;
    initializingRef.current = false;
    viewRef.current = EMPTY_CONVERSATION_VIEW;
    setView(EMPTY_CONVERSATION_VIEW);
    setActiveId(id);
  }, []);

  useEffect(() => {
    if (activeIdRef.current === conversationId) return;
    selectConversation(conversationId);
  }, [conversationId, selectConversation]);

  useEffect(() => {
    if (!enabled) return;
    const offFrame = platform?.onSessionFrame?.(receive);
    const offLive = platform?.onLiveFrame?.(receiveLive);
    if (!offFrame && !offLive) return;
    return () => {
      offFrame?.();
      offLive?.();
    };
  }, [enabled, platform, receive, receiveLive]);

  useEffect(() => {
    if (!enabled || !platform?.onConversationSnapshot) return;
    return platform.onConversationSnapshot(receiveSnapshot);
  }, [enabled, platform, receiveSnapshot]);

  useEffect(() => {
    if (!enabled || !activeId) return;
    const id = activeId;
    const generation = ++generationRef.current;
    let cancelled = false;
    initializingRef.current = true;
    resyncRef.current = false;
    const initialize = async () => {
      const snapshot =
        create && platform?.createConversation
          ? await platform.createConversation(id)
          : await (optionsRef.current.getSnapshot?.(id) ?? platform?.getConversationSnapshot?.(id));
      if (cancelled || generation !== generationRef.current || !snapshot) return;
      commitSnapshot(snapshot, false);
      const frames = await readAfter(id, viewRef.current.lastSeq);
      if (cancelled || generation !== generationRef.current) return;
      for (const frame of frames) {
        if (!applySequential(frame)) resyncRef.current = true;
      }
    };
    void initialize()
      .catch((error: unknown) => {
        console.error("[conversation-view] failed to initialize view", error);
      })
      .finally(() => {
        if (generation !== generationRef.current) return;
        initializingRef.current = false;
        if (resyncRef.current) void syncCursor();
      });
    return () => {
      cancelled = true;
      if (generation === generationRef.current) initializingRef.current = false;
    };
  }, [activeId, applySequential, commitSnapshot, create, enabled, platform, readAfter, syncCursor]);

  const waitForOutcome = useCallback((turnId: string) => {
    const done = finishedRef.current.get(turnId);
    if (done !== undefined) {
      finishedRef.current.delete(turnId);
      return Promise.resolve(done);
    }
    return new Promise<TurnOutcome>((resolve) => waitersRef.current.set(turnId, resolve));
  }, []);
  const clear = useCallback(() => {
    // 链路断开时在途活动不会再收到终态事实：清空必须同时结束等待者，
    // 否则发送方会永远停在等待完成的状态。
    generationRef.current += 1;
    initializingRef.current = false;
    resyncRef.current = false;
    for (const resolve of waitersRef.current.values()) resolve("aborted");
    waitersRef.current.clear();
    finishedRef.current.clear();
    // 新 worker 的 transcript 与序号都从头开始，旧游标必须归零，
    // 否则重连后的空快照和第一批事实都会被当成过期而丢弃。
    viewRef.current = EMPTY_CONVERSATION_VIEW;
    setView(EMPTY_CONVERSATION_VIEW);
  }, []);

  return {
    view,
    selectConversation,
    applySnapshot,
    reconcileSnapshot,
    waitForOutcome,
    getView: () => viewRef.current,
    clear,
  };
}

/** 终态事实到等待键的映射：只认 `turn-finished`。 */
function turnOutcomeOf(frame: SessionFrame): { turnId: string; outcome: TurnOutcome } | undefined {
  if (frame.event.type !== "turn-finished" || frame.turnId === undefined) return undefined;
  return { turnId: frame.turnId, outcome: frame.event.status };
}
