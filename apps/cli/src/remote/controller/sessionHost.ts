/** 把 RemoteControllerSession 适配回 CLI 现有 CodingSessionHost；TUI 不感知远程。 */
import type { RemoteControllerSession } from "@answra/remote";
import { RemoteOperationError, remoteError } from "@answra/remote";
import type { ConversationModelConfig } from "@answra/shared";
import type {
  AgentEventEnvelope,
  ConversationSnapshot,
  RemoteModelConfig,
} from "@answra/shared/schema";
import type { CodingSessionHost } from "../../session/codingSession";

export interface RemoteControllerSessionHostOptions {
  session: RemoteControllerSession;
  emitEvent(event: AgentEventEnvelope): void;
  onSnapshot?(snapshot: ConversationSnapshot): void;
}

interface RunWaiter {
  resolve(): void;
  reject(error: RemoteOperationError): void;
}

export function createRemoteControllerSessionHost({
  session,
  emitEvent,
  onSnapshot,
}: RemoteControllerSessionHostOptions): CodingSessionHost {
  const terminalRuns = new Set<string>();
  const runWaiters = new Map<string, RunWaiter[]>();
  let pendingConfigure: Promise<void> | undefined;
  let pendingCancel: Promise<void> | undefined;
  let closed = false;

  session.onSnapshot((snapshot) => {
    onSnapshot?.(snapshot);
  });
  session.onEvent((event) => {
    emitEvent(event);
    if (isTerminalRunEvent(event)) {
      terminalRuns.add(event.runId);
      settleRunWaiters(runWaiters, terminalRuns, event.runId);
    }
  });
  session.onState((state) => {
    if (state === "closed") {
      closed = true;
      rejectRunWaiters(runWaiters);
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
      return session.createConversation(conversationId);
    },
    async clearConversation(conversationId) {
      await takePendingConfigure();
      return session.clearConversation(conversationId);
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
