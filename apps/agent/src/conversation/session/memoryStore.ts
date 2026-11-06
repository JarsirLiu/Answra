/** Conversation transcript 的进程内仓储适配器，保存快照、revision 和有界 journal。 */
import type {
  ConversationChange,
  ConversationEvent,
  ConversationMessage,
  ConversationSnapshot,
} from "@answra/shared";
import type { RunOutcome } from "@answra/shared/schema";
import type { ConversationStore } from "./store";

type Session = {
  snapshot: ConversationSnapshot;
  journal: ConversationChange[];
  /** Per-run content sequence, reset when the run or session is cleared. */
  seqByRun: Map<string, number>;
};

/** Process-local adapter. SQLite can implement the same asynchronous port later. */
export class MemoryConversationStore implements ConversationStore {
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<(change: ConversationChange) => void>();

  async create(conversationId: string): Promise<ConversationSnapshot> {
    const existing = this.sessions.get(conversationId);
    if (existing) return cloneSnapshot(existing.snapshot);
    const session: Session = {
      snapshot: { conversationId, revision: 0, messages: [] },
      journal: [],
      seqByRun: new Map(),
    };
    this.sessions.set(conversationId, session);
    return cloneSnapshot(session.snapshot);
  }

  async load(conversationId: string): Promise<ConversationSnapshot> {
    const session = this.requireSession(conversationId);
    return cloneSnapshot(session.snapshot);
  }

  async clear(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session || session.snapshot.activeRunId) return;
    session.snapshot.messages = [];
    session.journal = [];
    session.seqByRun.clear();
    session.snapshot.revision += 1;
    this.publish({ type: "snapshot", snapshot: cloneSnapshot(session.snapshot) }, session);
  }

  async beginRun(
    conversationId: string,
    runId: string,
    userMessage: ConversationMessage,
  ): Promise<void> {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeRunId) throw new Error("当前回复尚未完成");
    if (userMessage.role !== "user") throw new Error("run 必须从用户消息开始");
    const assistantMessage: ConversationMessage = {
      id: runId,
      role: "assistant",
      text: "",
      images: [],
      status: "streaming",
    };
    session.snapshot.messages.push(
      { ...userMessage, images: [...userMessage.images] },
      assistantMessage,
    );
    session.snapshot.activeRunId = runId;
    session.snapshot.revision += 1;
    this.publish(
      {
        type: "messages-appended",
        conversationId,
        revision: session.snapshot.revision,
        messages: [userMessage, assistantMessage].map(cloneMessage),
        activeRunId: runId,
      },
      session,
    );
  }

  async beginReplyRun(conversationId: string, runId: string): Promise<ConversationMessage> {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeRunId) throw new Error("当前回复尚未完成");
    const last = session.snapshot.messages.at(-1);
    if (last?.role !== "user" || last.status !== "complete")
      throw new Error("没有可回复的用户消息");
    const claimedUser = cloneMessage(last);
    const assistantMessage: ConversationMessage = {
      id: runId,
      role: "assistant",
      text: "",
      images: [],
      status: "streaming",
    };
    session.snapshot.messages.push(assistantMessage);
    session.snapshot.activeRunId = runId;
    session.snapshot.revision += 1;
    this.publish(
      {
        type: "messages-appended",
        conversationId,
        revision: session.snapshot.revision,
        messages: [assistantMessage],
        activeRunId: runId,
      },
      session,
    );
    return claimedUser;
  }

  async appendUserMessage(conversationId: string, userMessage: ConversationMessage): Promise<void> {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeRunId) throw new Error("当前回复尚未完成");
    if (userMessage.role !== "user" || userMessage.status !== "complete")
      throw new Error("仅可追加已完成的用户消息");
    const message = cloneMessage(userMessage);
    session.snapshot.messages.push(message);
    session.snapshot.revision += 1;
    this.publish(
      {
        type: "messages-appended",
        conversationId,
        revision: session.snapshot.revision,
        messages: [message],
      },
      session,
    );
  }

  async beginEphemeralRun(
    conversationId: string,
    runId: string,
    userMessage: ConversationMessage,
  ): Promise<void> {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeRunId) throw new Error("当前回复尚未完成");
    if (userMessage.role !== "user") throw new Error("run 必须从用户消息开始");
    const assistantMessage: ConversationMessage = {
      id: runId,
      role: "assistant",
      text: "",
      images: [],
      status: "streaming",
    };
    // 一次性答题：上一轮的消息与 journal 只属于上一轮运行，认领时一步清空；
    // revision 单调递增，事件游标过旧时按既有规则回退到 snapshot。
    session.snapshot.messages = [];
    session.snapshot.messages.push(
      { ...userMessage, images: [...userMessage.images] },
      assistantMessage,
    );
    session.snapshot.activeRunId = runId;
    session.snapshot.revision += 1;
    session.journal = [];
    session.seqByRun.clear();
    this.publish(
      {
        type: "messages-appended",
        conversationId,
        revision: session.snapshot.revision,
        messages: [userMessage, assistantMessage].map(cloneMessage),
        activeRunId: runId,
      },
      session,
    );
  }

  async appendEvent(
    event: Omit<ConversationEvent, "revision" | "seq">,
  ): Promise<ConversationChange> {
    const session = this.requireSession(event.conversationId);
    if (session.snapshot.activeRunId !== event.runId) throw new Error("会话没有匹配的活动 run");
    const seq = (session.seqByRun.get(event.runId) ?? 0) + 1;
    session.seqByRun.set(event.runId, seq);
    const stored: ConversationEvent = {
      ...event,
      seq,
      revision: ++session.snapshot.revision,
    };
    if (stored.stream.type === "text-delta") {
      const message = session.snapshot.messages.find((item) => item.id === event.runId);
      if (message) message.text += stored.stream.delta;
    }
    const change: ConversationChange = { type: "event", event: stored };
    this.publish(change, session);
    return change;
  }

  async finishRun(conversationId: string, runId: string, outcome: RunOutcome): Promise<void> {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeRunId !== runId) return;
    const message = session.snapshot.messages.find((item) => item.id === runId);
    if (!message) return;
    message.status =
      outcome === "completed" ? "complete" : outcome === "failed" ? "failed" : "interrupted";
    delete session.snapshot.activeRunId;
    session.seqByRun.delete(runId);
    session.snapshot.revision += 1;
    this.publish(
      {
        type: "run-finished",
        conversationId,
        revision: session.snapshot.revision,
        runId,
        outcome,
        message: cloneMessage(message),
      },
      session,
    );
  }

  async readAfter(conversationId: string, revision: number): Promise<ConversationChange[]> {
    const session = this.requireSession(conversationId);
    if (revision > session.snapshot.revision)
      return [{ type: "snapshot", snapshot: cloneSnapshot(session.snapshot) }];
    const oldest = session.journal[0];
    if (!oldest && revision < session.snapshot.revision)
      return [{ type: "snapshot", snapshot: cloneSnapshot(session.snapshot) }];
    if (oldest && revision < oldestRevision(oldest) - 1)
      return [{ type: "snapshot", snapshot: cloneSnapshot(session.snapshot) }];
    return session.journal.filter((change) => changeRevision(change) > revision).map(cloneChange);
  }

  subscribe(listener: (change: ConversationChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private requireSession(conversationId: string): Session {
    const session = this.sessions.get(conversationId);
    if (!session) throw new Error("会话不存在");
    return session;
  }

  private publish(change: ConversationChange, session: Session): void {
    session.journal.push(cloneChange(change));
    if (session.journal.length > 2048) session.journal.splice(0, session.journal.length - 2048);
    for (const listener of this.listeners) listener(cloneChange(change));
  }
}

function cloneSnapshot(snapshot: ConversationSnapshot): ConversationSnapshot {
  return {
    ...snapshot,
    messages: snapshot.messages.map(cloneMessage),
  };
}

function cloneMessage(message: ConversationMessage): ConversationMessage {
  return { ...message, images: [...message.images] };
}

function cloneChange(change: ConversationChange): ConversationChange {
  switch (change.type) {
    case "snapshot":
      return { type: change.type, snapshot: cloneSnapshot(change.snapshot) };
    case "messages-appended":
      return {
        ...change,
        messages: change.messages.map(cloneMessage),
      };
    case "event":
      return { type: change.type, event: { ...change.event } };
    case "run-finished":
      return { ...change, message: cloneMessage(change.message) };
  }
}

function changeRevision(change: ConversationChange): number {
  if (change.type === "event") return change.event.revision;
  return change.type === "snapshot" ? change.snapshot.revision : change.revision;
}

function oldestRevision(change: ConversationChange): number {
  return changeRevision(change);
}
