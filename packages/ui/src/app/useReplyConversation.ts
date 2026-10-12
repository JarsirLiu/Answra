import type {
  ConversationChange,
  ConversationMessage,
  ConversationSnapshot,
  DesktopBridge,
  ReplyBarActivity,
} from "@answra/shared";
import { ActiveExamConversationId } from "@answra/shared";
import { useEffect, useRef, useState } from "react";
import { projectReplyActivity } from "./replyActivity";

export interface ReplyConversationMessage extends ConversationMessage {
  activities: ReplyBarActivity[];
}

interface ReplyConversationState {
  messages: ReplyConversationMessage[];
  activeRunId?: string;
  error?: string;
}

const EMPTY_STATE: ReplyConversationState = { messages: [] };

export function useReplyConversation(
  platform: DesktopBridge | undefined,
  enabled: boolean,
): ReplyConversationState {
  const [state, setState] = useState(EMPTY_STATE);
  const revisionRef = useRef(0);

  useEffect(() => {
    if (
      !enabled ||
      !platform?.getConversationSnapshot ||
      !platform.readConversationEvents ||
      !platform.onConversationChange
    ) {
      revisionRef.current = 0;
      setState(EMPTY_STATE);
      return;
    }

    const { getConversationSnapshot, readConversationEvents, onConversationChange } = platform;

    let alive = true;
    let ready = false;
    let queued: ConversationChange[] = [];
    let processing = Promise.resolve();
    const activityByRun = new Map<string, ReplyBarActivity[]>();

    const applySnapshot = (snapshot: ConversationSnapshot) => {
      if (
        !alive ||
        snapshot.conversationId !== ActiveExamConversationId ||
        snapshot.revision < revisionRef.current
      )
        return;
      revisionRef.current = snapshot.revision;
      setState((current) => ({
        ...current,
        messages: snapshot.messages.map((message) => ({
          ...message,
          activities: activityByRun.get(message.id) ?? [],
        })),
        activeRunId: snapshot.activeRunId,
        error: undefined,
      }));
    };

    const addActivity = (
      runId: string,
      event: Extract<ConversationChange, { type: "event" }>["event"],
    ) => {
      const next = projectReplyActivity(activityByRun.get(runId) ?? [], event);
      activityByRun.set(runId, next);
      setState((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === runId ? { ...message, activities: next } : message,
        ),
        ...(event.chunk.type === "error" ? { error: event.chunk.errorText } : {}),
      }));
    };

    const applyContiguous = (change: ConversationChange): boolean => {
      const revision = getRevision(change);
      if (change.type === "snapshot") {
        if (revision > revisionRef.current) applySnapshot(change.snapshot);
        return true;
      }
      if (revision <= revisionRef.current) return true;
      if (revision !== revisionRef.current + 1) return false;

      revisionRef.current = revision;
      if (change.type === "messages-appended") {
        setState((current) => ({
          ...current,
          activeRunId: change.activeRunId,
          messages: [
            ...current.messages,
            ...change.messages.map((message) => ({ ...message, activities: [] })),
          ],
        }));
      } else if (change.type === "event") {
        const { event } = change;
        if (event.chunk.type === "text-delta") {
          const delta = event.chunk.delta;
          setState((current) => ({
            ...current,
            messages: current.messages.map((message) =>
              message.id === event.runId ? { ...message, text: message.text + delta } : message,
            ),
          }));
        }
        addActivity(event.runId, event);
      } else {
        const priorActivities = activityByRun.get(change.runId) ?? [];
        setState((current) => ({
          ...current,
          activeRunId: current.activeRunId === change.runId ? undefined : current.activeRunId,
          messages: current.messages.map((message) =>
            message.id === change.runId
              ? { ...change.message, activities: priorActivities }
              : message,
          ),
        }));
      }
      return true;
    };

    const applyWithRecovery = async (change: ConversationChange) => {
      if (change.type === "event" && change.event.conversationId !== ActiveExamConversationId)
        return;
      if (
        change.type !== "event" &&
        change.type !== "snapshot" &&
        change.conversationId !== ActiveExamConversationId
      )
        return;
      const revision = getRevision(change);
      if (revision <= revisionRef.current) return;
      if (revision > revisionRef.current + 1) {
        const missing = await readConversationEvents(ActiveExamConversationId, revisionRef.current);
        for (const recovered of missing) applyContiguous(recovered);
        if (revision > revisionRef.current + 1) {
          const latest = await getConversationSnapshot(ActiveExamConversationId);
          applySnapshot(latest);
        }
      }
      applyContiguous(change);
    };

    const unsubscribe = onConversationChange((change) => {
      if (!ready) {
        queued.push(change);
        return;
      }
      processing = processing
        .then(() => applyWithRecovery(change))
        .catch((error: unknown) => {
          if (alive) setState((current) => ({ ...current, error: errorMessage(error) }));
        });
    });

    const initialize = async () => {
      try {
        const snapshot = await getConversationSnapshot(ActiveExamConversationId);
        if (!alive) return;
        applySnapshot(snapshot);
        const history = await readConversationEvents(ActiveExamConversationId, 0);
        if (!alive) return;
        const later: ConversationChange[] = [];
        for (const change of history) {
          if (change.type === "snapshot") {
            if (change.snapshot.revision > revisionRef.current) applySnapshot(change.snapshot);
          } else if (getRevision(change) <= revisionRef.current) {
            if (change.type === "event") {
              const activities = projectReplyActivity(
                activityByRun.get(change.event.runId) ?? [],
                change.event,
              );
              activityByRun.set(change.event.runId, activities);
            }
          } else {
            later.push(change);
          }
        }
        setState((current) => ({
          ...current,
          messages: current.messages.map((message) => ({
            ...message,
            activities: activityByRun.get(message.id) ?? message.activities,
          })),
        }));
        ready = true;
        queued = [...later, ...queued].sort(
          (left, right) => getRevision(left) - getRevision(right),
        );
        for (const change of queued) await applyWithRecovery(change);
        queued = [];
      } catch (error) {
        if (alive) {
          ready = true;
          setState((current) => ({ ...current, error: errorMessage(error) }));
          const pending = queued.sort((left, right) => getRevision(left) - getRevision(right));
          queued = [];
          for (const change of pending) {
            try {
              await applyWithRecovery(change);
            } catch {
              break;
            }
          }
        }
      }
    };
    void initialize();

    return () => {
      alive = false;
      unsubscribe();
      queued = [];
    };
  }, [enabled, platform]);

  return state;
}

function getRevision(change: ConversationChange): number {
  if (change.type === "event") return change.event.revision;
  return change.type === "snapshot" ? change.snapshot.revision : change.revision;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "读取对话失败";
}
