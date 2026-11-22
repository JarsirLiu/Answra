/**
 * 会话视图的唯一游标与折叠入口。
 *
 * 会话路径吃 `SessionFrame`（durable，按 `seq` 重放）与 `LiveFrame`（可丢增量）；
 * Answer 在 P3 前仍吃旧 `AgentEventEnvelope`，两条通道不混用、不合并状态。
 */
import type {
  AgentEventEnvelope,
  ConversationSnapshot,
  DesktopBridge,
  LiveFrame,
  SessionFrame,
} from "@answra/shared";
import type { RunOutcome } from "@answra/shared/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyAgentEvent,
  applyConversationSnapshot,
  type ConversationProjectionOptions,
  type ConversationView,
  conversationOf,
  EMPTY_CONVERSATION_VIEW,
  foldConversationFrame,
  overlayLiveFrame,
} from "./conversationView";

/** durable 帧或 Answer shim 的旧 envelope；由 `transport` 决定实际来源。 */
type ViewPayload = SessionFrame | AgentEventEnvelope;

/** 事实通道：`events` 只服务 P3 前的 Answer。 */
export type ConversationTransport = "frames" | "events";

export interface UseConversationViewOptions extends ConversationProjectionOptions {
  enabled?: boolean;
  create?: boolean;
  transport?: ConversationTransport;
  /** 领域自己的权威快照读取；缺省走通用 conversation bridge。 */
  getSnapshot?: (conversationId: string) => Promise<ConversationSnapshot>;
}

export interface ConversationViewHandle {
  view: ConversationView;
  selectConversation: (conversationId: string | undefined) => void;
  applySnapshot: (snapshot: ConversationSnapshot) => void;
  reconcileSnapshot: (snapshot: ConversationSnapshot) => Promise<void>;
  /**
   * 等待一次活动结束：`frames` 传 Turn id，`events`（Answer shim）传 run id。
   * 终态只认各自通道的终态事实。
   */
  waitForOutcome: (activityId: string) => Promise<RunOutcome>;
  getView: () => ConversationView;
  clear: () => void;
}

export function useConversationView(
  platform: DesktopBridge | undefined,
  conversationId: string | undefined,
  options: UseConversationViewOptions = {},
): ConversationViewHandle {
  const { enabled = true, create = true, transport = "frames" } = options;
  const [activeId, setActiveId] = useState(conversationId);
  const [view, setView] = useState(EMPTY_CONVERSATION_VIEW);
  const activeIdRef = useRef(conversationId);
  const viewRef = useRef(view);
  const optionsRef = useRef(options);
  const generationRef = useRef(0);
  const waitersRef = useRef(new Map<string, (outcome: RunOutcome) => void>());
  const finishedRef = useRef(new Map<string, RunOutcome>());
  const syncingRef = useRef(false);
  const resyncRef = useRef(false);
  const initializingRef = useRef(false);
  optionsRef.current = options;

  const resolveOutcome = useCallback((activityId: string, outcome: RunOutcome) => {
    const waiter = waitersRef.current.get(activityId);
    if (waiter !== undefined) {
      waitersRef.current.delete(activityId);
      waiter(outcome);
      return;
    }
    finishedRef.current.set(activityId, outcome);
  }, []);

  /** 折叠一条本会话载荷；返回 false 表示游标有缺口，调用方必须整段重读。 */
  const applySequential = useCallback(
    (payload: ViewPayload): boolean => {
      const current = viewRef.current;
      if (payloadSession(payload) !== activeIdRef.current) return true;
      const cursor = payloadCursor(payload);
      const known = cursorOf(current, transport);
      if (cursor <= known) return true;
      if (cursor !== known + 1) return false;
      const terminal = payloadOutcome(payload);
      if (terminal !== undefined) resolveOutcome(terminal.activityId, terminal.outcome);
      const next = applyPayload(current, payload, optionsRef.current);
      if (next === current) return true;
      viewRef.current = next;
      setView(next);
      return true;
    },
    [resolveOutcome, transport],
  );

  const readAfter = useCallback(
    async (id: string, cursor: number): Promise<ViewPayload[]> => {
      if (transport === "frames") return (await platform?.readSessionFrames?.(id, cursor)) ?? [];
      return (await platform?.readConversationEvents?.(id, cursor)) ?? [];
    },
    [platform, transport],
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
        const payloads = await readAfter(id, cursorOf(viewRef.current, transport));
        if (generation !== generationRef.current || activeIdRef.current !== id) return;
        for (const payload of payloads) {
          if (!applySequential(payload)) resyncRef.current = true;
        }
      }
    } catch (error) {
      resyncRef.current = true;
      console.error("[conversation-view] failed to sync session frames", error);
    } finally {
      syncingRef.current = false;
    }
  }, [applySequential, readAfter, transport]);

  const receive = useCallback(
    (payload: ViewPayload) => {
      if (!activeIdRef.current || payloadSession(payload) !== activeIdRef.current) return;
      if (initializingRef.current) {
        resyncRef.current = true;
        return;
      }
      if (!applySequential(payload)) resyncRef.current = true;
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
    (snapshot: ConversationSnapshot) =>
      transport === "frames"
        ? snapshot.lastSeq < viewRef.current.lastSeq
        : snapshot.eventRevision < viewRef.current.eventRevision,
    [transport],
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
        const payloads = await readAfter(snapshot.conversationId, cursorOf(next, transport));
        if (generation !== generationRef.current) return;
        for (const payload of payloads) {
          if (!applySequential(payload)) resyncRef.current = true;
        }
      } finally {
        if (generation === generationRef.current) {
          initializingRef.current = false;
          if (resyncRef.current) void syncCursor();
        }
      }
    },
    [applySequential, isStaleSnapshot, readAfter, syncCursor, transport],
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
    if (transport === "frames") {
      const offFrame = platform?.onSessionFrame?.(receive);
      const offLive = platform?.onLiveFrame?.(receiveLive);
      if (!offFrame && !offLive) return;
      return () => {
        offFrame?.();
        offLive?.();
      };
    }
    if (!platform?.onConversationEvent) return;
    return platform.onConversationEvent(receive);
  }, [enabled, platform, receive, receiveLive, transport]);

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
      const payloads = await readAfter(id, cursorOf(viewRef.current, transport));
      if (cancelled || generation !== generationRef.current) return;
      for (const payload of payloads) {
        if (!applySequential(payload)) resyncRef.current = true;
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
  }, [
    activeId,
    applySequential,
    commitSnapshot,
    create,
    enabled,
    platform,
    readAfter,
    syncCursor,
    transport,
  ]);

  const waitForOutcome = useCallback((activityId: string) => {
    const done = finishedRef.current.get(activityId);
    if (done !== undefined) {
      finishedRef.current.delete(activityId);
      return Promise.resolve(done);
    }
    return new Promise<RunOutcome>((resolve) => waitersRef.current.set(activityId, resolve));
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

function isSessionFrame(payload: ViewPayload): payload is SessionFrame {
  return "seq" in payload;
}

function cursorOf(view: ConversationView, transport: ConversationTransport): number {
  return transport === "frames" ? view.lastSeq : view.eventRevision;
}

function payloadSession(payload: ViewPayload): string {
  return isSessionFrame(payload) ? payload.sessionId : conversationOf(payload);
}

function payloadCursor(payload: ViewPayload): number {
  return isSessionFrame(payload) ? payload.seq : payload.aggregateRevision;
}

function applyPayload(
  view: ConversationView,
  payload: ViewPayload,
  options: ConversationProjectionOptions,
): ConversationView {
  return isSessionFrame(payload)
    ? foldConversationFrame(view, payload, options)
    : applyAgentEvent(view, payload, options);
}

/** 终态事实到等待键的映射：Turn 用 `turnId`，Answer shim 用 envelope 的 `runId`。 */
function payloadOutcome(
  payload: ViewPayload,
): { activityId: string; outcome: RunOutcome } | undefined {
  if (isSessionFrame(payload)) {
    if (payload.event.type !== "turn-finished" || payload.turnId === undefined) return undefined;
    return { activityId: payload.turnId, outcome: payload.event.status };
  }
  if (payload.event.type !== "run-state-changed") return undefined;
  switch (payload.event.state) {
    case "completed":
      return { activityId: payload.runId, outcome: "completed" };
    case "failed":
    case "orphaned":
      return { activityId: payload.runId, outcome: "failed" };
    case "aborted":
      return { activityId: payload.runId, outcome: "aborted" };
    case "superseded":
      return { activityId: payload.runId, outcome: "superseded" };
    case "queued":
    case "claimed":
    case "running":
    case "retry-wait":
      return undefined;
  }
}
