/** 把 RemoteControllerSession/Connection 适配成 CLI 现有 CodingSessionHost；TUI 不感知远程。 */
import type { HostModelSettingsPort, RemoteControllerSession } from "@answra/remote";
import { RemoteOperationError, remoteError } from "@answra/remote";
import type { ConversationModelConfig } from "@answra/shared";
import type {
  AgentEventEnvelope,
  ConversationSnapshot,
  RemoteModelConfig,
} from "@answra/shared/schema";
import type { CodingSessionHost } from "../../session/codingSession";

export interface RemoteControllerClient<TState extends string = string> {
  createConversation(conversationId: string): Promise<ConversationSnapshot>;
  clearConversation(conversationId: string): Promise<ConversationSnapshot>;
  snapshot(conversationId: string): Promise<ConversationSnapshot>;
  readEvents(conversationId: string, afterRevision: number): Promise<AgentEventEnvelope[]>;
  send(
    command: Parameters<RemoteControllerSession["send"]>[0],
  ): ReturnType<RemoteControllerSession["send"]>;
  waitQueueStart(
    conversationId: string,
    queueId: string,
  ): Promise<{ queueId: string; runId: string; snapshot: ConversationSnapshot }>;
  cancel(runId: string): Promise<void>;
  applyModel(config: RemoteModelConfig): Promise<void>;
  settings(): HostModelSettingsPort;
  onSnapshot(listener: (snapshot: ConversationSnapshot) => void): () => void;
  onEvent(listener: (event: AgentEventEnvelope) => void): () => void;
  onState(listener: (state: TState) => void): () => void;
  close(): void;
}

export interface RemoteControllerSessionHostOptions<TState extends string = string> {
  session: RemoteControllerClient<TState>;
  emitEvent(event: AgentEventEnvelope): void;
  onSnapshot?(snapshot: ConversationSnapshot): void;
  onResyncError?(error: unknown): void;
}

interface RunWaiter {
  resolve(): void;
  reject(error: RemoteOperationError): void;
}

export function createRemoteControllerSessionHost<TState extends string = string>({
  session,
  emitEvent,
  onSnapshot,
  onResyncError,
}: RemoteControllerSessionHostOptions<TState>): CodingSessionHost {
  const terminalRuns = new Set<string>();
  const runWaiters = new Map<string, RunWaiter[]>();
  const conversations = new Set<string>();
  const revisions = new Map<string, number>();
  let pendingConfigure: Promise<void> | undefined;
  let pendingCancel: Promise<void> | undefined;
  let closed = false;
  let degraded = false;
  let resyncing = false;

  session.onSnapshot((snapshot) => {
    applySnapshot(snapshot);
  });
  session.onEvent((event) => {
    applyEvent(event);
  });
  session.onState((state) => {
    if (state === "closed") {
      closed = true;
      rejectRunWaiters(runWaiters);
      return;
    }
    if (state === "interrupted" || state === "reconnecting") {
      degraded = true;
      return;
    }
    if (state === "ready" && degraded) {
      degraded = false;
      void resyncConversations();
    }
  });

  return {
    configure(model) {
      const next = session.applyModel(toRemoteModelConfig(model));
      void next.catch(() => undefined);
      pendingConfigure = pendingConfigure === undefined ? next : pendingConfigure.then(() => next);
      void pendingConfigure.catch(() => undefined);
    },
    async createConversation(conversationId) {
      await takePendingConfigure();
      const snapshot = await session.createConversation(conversationId);
      conversations.add(conversationId);
      revisions.set(conversationId, snapshot.eventRevision);
      return snapshot;
    },
    async clearConversation(conversationId) {
      await takePendingConfigure();
      const snapshot = await session.clearConversation(conversationId);
      conversations.add(conversationId);
      revisions.set(conversationId, snapshot.eventRevision);
      return snapshot;
    },
    async enqueue(conversationId, request, _accessToken: string) {
      await takePendingConfigure();
      return session.send({
        operation: "chat.send",
        conversationId,
        request,
      });
    },
    waitForQueueStart(conversationId, queueId) {
      return session.waitQueueStart(conversationId, queueId);
    },
    async send(conversationId, request, _accessToken: string): Promise<{ runId: string }> {
      await takePendingConfigure();
      const accepted = await session.send({
        operation: "chat.send",
        conversationId,
        request,
      });
      if (accepted.status === "started") return { runId: accepted.runId };
      const started = await session.waitQueueStart(conversationId, accepted.queueId);
      return { runId: started.runId };
    },
    cancel(runId) {
      const next = session.cancel(runId);
      void next.catch(() => undefined);
      pendingCancel = next;
    },
    async waitForRun(runId) {
      const cancel = pendingCancel;
      pendingCancel = undefined;
      if (cancel !== undefined) await cancel;
      if (terminalRuns.delete(runId)) return;
      if (closed) {
        throw new RemoteOperationError(remoteError("remote-disconnected", "remote session closed"));
      }
      return new Promise<void>((resolve, reject) => {
        const waiters = runWaiters.get(runId) ?? [];
        waiters.push({ resolve, reject });
        runWaiters.set(runId, waiters);
      });
    },
    dispose() {
      session.close();
    },
  };

  function applySnapshot(snapshot: ConversationSnapshot): void {
    revisions.set(snapshot.conversationId, snapshot.eventRevision);
    onSnapshot?.(snapshot);
  }

  function applyEvent(event: AgentEventEnvelope): void {
    const current = revisions.get(event.conversationId) ?? 0;
    revisions.set(event.conversationId, Math.max(current, event.aggregateRevision));
    emitEvent(event);
    if (isTerminalRunEvent(event)) {
      terminalRuns.add(event.runId);
      settleRunWaiters(runWaiters, terminalRuns, event.runId);
    }
  }

  async function resyncConversations(): Promise<void> {
    if (resyncing) return;
    resyncing = true;
    try {
      for (const conversationId of conversations) {
        const snapshot = await session.snapshot(conversationId);
        applySnapshot(snapshot);
        const events = await session.readEvents(conversationId, revisions.get(conversationId) ?? 0);
        for (const event of events) applyEvent(event);
      }
    } catch (error) {
      onResyncError?.(error);
    } finally {
      resyncing = false;
    }
  }

  async function takePendingConfigure(): Promise<void> {
    const pending = pendingConfigure;
    pendingConfigure = undefined;
    if (pending !== undefined) await pending;
  }
}

function toRemoteModelConfig(model: ConversationModelConfig): RemoteModelConfig {
  return {
    chat: {
      baseUrl: model.chat.baseUrl,
      model: model.chat.model,
      ...(model.chat.auth === undefined ? {} : { auth: model.chat.auth }),
    },
    answer: {
      baseUrl: model.answer.baseUrl,
      model: model.answer.model,
      ...(model.answer.auth === undefined ? {} : { auth: model.answer.auth }),
    },
  };
}

function isTerminalRunEvent(event: AgentEventEnvelope): boolean {
  if (event.event.type !== "run-state-changed") return false;
  return (
    event.event.state === "completed" ||
    event.event.state === "failed" ||
    event.event.state === "aborted"
  );
}

function settleRunWaiters(
  waitersByRun: Map<string, RunWaiter[]>,
  terminalRuns: Set<string>,
  runId: string,
): void {
  const waiters = waitersByRun.get(runId);
  if (waiters === undefined) return;
  waitersByRun.delete(runId);
  terminalRuns.delete(runId);
  for (const waiter of waiters) waiter.resolve();
}

function rejectRunWaiters(waitersByRun: Map<string, RunWaiter[]>): void {
  for (const waiters of waitersByRun.values()) {
    for (const waiter of waiters) {
      waiter.reject(
        new RemoteOperationError(remoteError("remote-disconnected", "remote session closed")),
      );
    }
  }
  waitersByRun.clear();
}
