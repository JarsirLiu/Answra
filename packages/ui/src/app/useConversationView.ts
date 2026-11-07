import type { AgentEventEnvelope, DesktopBridge } from "@answra/shared";
import type { RunOutcome } from "@answra/shared/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyAgentEvent,
  applyConversationSnapshot,
  type ConversationProjectionOptions,
  type ConversationView,
  conversationOf,
  EMPTY_CONVERSATION_VIEW,
} from "./conversationView";

export interface UseConversationViewOptions extends ConversationProjectionOptions {
  enabled?: boolean;
  create?: boolean;
}
export interface ConversationViewHandle {
  view: ConversationView;
  selectConversation: (conversationId: string | undefined) => void;
  applySnapshot: (snapshot: import("@answra/shared").ConversationSnapshot) => void;
  reconcileRunSnapshot: (snapshot: import("@answra/shared").ConversationSnapshot) => Promise<void>;
  waitForRun: (runId: string) => Promise<RunOutcome>;
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
  const waitersRef = useRef(new Map<string, (outcome: RunOutcome) => void>());
  const finishedRef = useRef(new Map<string, RunOutcome>());
  const pendingEventsRef = useRef(new Map<number, AgentEventEnvelope>());
  const drainingRef = useRef(false);
  const initializingRef = useRef(false);
  optionsRef.current = options;

  const commit = useCallback((event: AgentEventEnvelope) => {
    if (!activeIdRef.current || conversationOf(event) !== activeIdRef.current) return;
    const outcome = terminalOutcome(event);
    if (outcome) {
      const waiter = waitersRef.current.get(event.runId);
      if (waiter) {
        waitersRef.current.delete(event.runId);
        waiter(outcome);
      } else finishedRef.current.set(event.runId, outcome);
    }
    const next = applyAgentEvent(viewRef.current, event, optionsRef.current);
    if (next === viewRef.current) return;
    viewRef.current = next;
    setView(next);
  }, []);
  const drainEvents = useCallback(async () => {
    if (drainingRef.current || initializingRef.current || !activeIdRef.current) return;
    drainingRef.current = true;
    const conversationId = activeIdRef.current;
    try {
      for (;;) {
        const cursor = viewRef.current.eventRevision;
        const nextRevision = cursor + 1;
        if (!pendingEventsRef.current.has(nextRevision)) {
          const hasLaterEvent = [...pendingEventsRef.current.keys()].some(
            (revision) => revision > nextRevision,
          );
          if (!hasLaterEvent) return;
          const recovered = await platform?.readConversationEvents?.(conversationId, cursor);
          if (activeIdRef.current !== conversationId) return;
          for (const event of recovered ?? [])
            pendingEventsRef.current.set(event.aggregateRevision, event);
          if (!pendingEventsRef.current.has(nextRevision)) return;
        }
        const event = pendingEventsRef.current.get(nextRevision);
        if (!event) return;
        pendingEventsRef.current.delete(nextRevision);
        commit(event);
      }
    } finally {
      drainingRef.current = false;
      if (pendingEventsRef.current.has(viewRef.current.eventRevision + 1)) void drainEvents();
    }
  }, [commit, platform]);
  const receiveEvent = useCallback(
    (event: AgentEventEnvelope) => {
      if (!activeIdRef.current || conversationOf(event) !== activeIdRef.current) return;
      if (event.aggregateRevision <= viewRef.current.eventRevision) return;
      pendingEventsRef.current.set(event.aggregateRevision, event);
      void drainEvents();
    },
    [drainEvents],
  );

  const selectConversation = useCallback((id: string | undefined) => {
    activeIdRef.current = id;
    generationRef.current += 1;
    pendingEventsRef.current.clear();
    initializingRef.current = false;
    viewRef.current = EMPTY_CONVERSATION_VIEW;
    setView(EMPTY_CONVERSATION_VIEW);
    setActiveId(id);
  }, []);
  const commitSnapshot = useCallback(
    (
      snapshot: import("@answra/shared").ConversationSnapshot,
      invalidateInitialization: boolean,
    ) => {
      if (activeIdRef.current !== snapshot.conversationId) return;
      if (snapshot.eventRevision < viewRef.current.eventRevision) return;
      if (invalidateInitialization) {
        generationRef.current += 1;
        initializingRef.current = false;
      }
      for (const revision of pendingEventsRef.current.keys()) {
        if (revision <= snapshot.eventRevision) pendingEventsRef.current.delete(revision);
      }
      const next = applyConversationSnapshot(viewRef.current, snapshot, optionsRef.current);
      viewRef.current = next;
      setView(next);
      void drainEvents();
    },
    [drainEvents],
  );
  const applySnapshot = useCallback(
    (snapshot: import("@answra/shared").ConversationSnapshot) => {
      commitSnapshot(snapshot, true);
    },
    [commitSnapshot],
  );
  const reconcileRunSnapshot = useCallback(
    async (snapshot: import("@answra/shared").ConversationSnapshot) => {
      if (activeIdRef.current !== snapshot.conversationId) return;
      initializingRef.current = true;
      pendingEventsRef.current.clear();
      const next = applyConversationSnapshot(viewRef.current, snapshot, optionsRef.current);
      viewRef.current = next;
      setView(next);
      try {
        const events =
          (await platform?.readConversationEvents?.(
            snapshot.conversationId,
            snapshot.eventRevision,
          )) ?? [];
        if (activeIdRef.current !== snapshot.conversationId) return;
        for (const event of events) pendingEventsRef.current.set(event.aggregateRevision, event);
      } finally {
        initializingRef.current = false;
        await drainEvents();
      }
    },
    [drainEvents, platform],
  );
  const receiveSnapshot = applySnapshot;

  useEffect(() => {
    if (activeIdRef.current === conversationId) return;
    activeIdRef.current = conversationId;
    generationRef.current += 1;
    viewRef.current = EMPTY_CONVERSATION_VIEW;
    setView(EMPTY_CONVERSATION_VIEW);
    setActiveId(conversationId);
  }, [conversationId]);

  useEffect(() => {
    if (!enabled || !platform?.onConversationEvent) return;
    return platform.onConversationEvent(receiveEvent);
  }, [enabled, platform, receiveEvent]);

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
    pendingEventsRef.current.clear();
    const initialize = async () => {
      const snapshot =
        create && platform?.createConversation
          ? await platform.createConversation(id)
          : await platform?.getConversationSnapshot?.(id);
      if (cancelled || generation !== generationRef.current || !snapshot) return;
      commitSnapshot(snapshot, false);
      const events = (await platform?.readConversationEvents?.(id, snapshot.eventRevision)) ?? [];
      if (cancelled || generation !== generationRef.current) return;
      for (const event of events) pendingEventsRef.current.set(event.aggregateRevision, event);
      initializingRef.current = false;
      await drainEvents();
    };
    void initialize().finally(() => {
      if (generation === generationRef.current) {
        initializingRef.current = false;
        void drainEvents();
      }
    });
    return () => {
      cancelled = true;
      if (generation === generationRef.current) initializingRef.current = false;
    };
  }, [activeId, create, enabled, platform, commitSnapshot, drainEvents]);

  const waitForRun = useCallback((runId: string) => {
    const done = finishedRef.current.get(runId);
    if (done) {
      finishedRef.current.delete(runId);
      return Promise.resolve(done);
    }
    return new Promise<RunOutcome>((resolve) => waitersRef.current.set(runId, resolve));
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
  return {
    view,
    selectConversation,
    applySnapshot,
    reconcileRunSnapshot,
    waitForRun,
    getView: () => viewRef.current,
    clear,
  };
}

function terminalOutcome(event: AgentEventEnvelope): RunOutcome | undefined {
  if (event.event.type !== "run-state-changed") return undefined;
  switch (event.event.state) {
    case "completed":
      return "completed";
    case "failed":
    case "orphaned":
      return "failed";
    case "aborted":
      return "aborted";
    case "superseded":
      return "superseded";
    case "queued":
    case "claimed":
    case "running":
    case "retry-wait":
      return undefined;
  }
}
