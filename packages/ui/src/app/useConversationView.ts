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
  optionsRef.current = options;

  const commit = useCallback((event: AgentEventEnvelope) => {
    if (!activeIdRef.current || conversationOf(event) !== activeIdRef.current) return;
    const next = applyAgentEvent(viewRef.current, event, optionsRef.current);
    if (next === viewRef.current) return;
    viewRef.current = next;
    setView(next);
    if (
      event.event.type === "run-state-changed" &&
      ["completed", "failed", "aborted", "superseded", "orphaned"].includes(event.event.state)
    ) {
      const outcome: RunOutcome =
        event.event.state === "completed"
          ? "completed"
          : event.event.state === "aborted"
            ? "aborted"
            : event.event.state === "superseded"
              ? "superseded"
              : "failed";
      const waiter = waitersRef.current.get(event.runId);
      if (waiter) {
        waitersRef.current.delete(event.runId);
        waiter(outcome);
      } else finishedRef.current.set(event.runId, outcome);
    }
  }, []);

  const selectConversation = useCallback((id: string | undefined) => {
    activeIdRef.current = id;
    generationRef.current += 1;
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
      if (invalidateInitialization) generationRef.current += 1;
      const next = applyConversationSnapshot(viewRef.current, snapshot, optionsRef.current);
      viewRef.current = next;
      setView(next);
    },
    [],
  );
  const applySnapshot = useCallback(
    (snapshot: import("@answra/shared").ConversationSnapshot) => {
      commitSnapshot(snapshot, true);
    },
    [commitSnapshot],
  );

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
    return platform.onConversationEvent(commit);
  }, [commit, enabled, platform]);

  useEffect(() => {
    if (!enabled || !activeId) return;
    const id = activeId;
    const generation = ++generationRef.current;
    let cancelled = false;
    const initialize = async () => {
      const snapshot =
        create && platform?.createConversation
          ? await platform.createConversation(id)
          : await platform?.getConversationSnapshot?.(id);
      if (cancelled || generation !== generationRef.current || !snapshot) return;
      commitSnapshot(snapshot, false);
      const events = (await platform?.readConversationEvents?.(id, 0)) ?? [];
      if (cancelled || generation !== generationRef.current) return;
      for (const event of events) commit(event);
    };
    void initialize();
    return () => {
      cancelled = true;
    };
  }, [activeId, create, enabled, platform, commit, commitSnapshot]);

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
    waitForRun,
    getView: () => viewRef.current,
    clear,
  };
}
