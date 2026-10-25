import type {
  ConversationChange,
  ConversationEvent,
  ConversationMessage,
  ConversationSendRequest,
  ConversationSnapshot,
} from "@answra/shared";

export interface ConversationStore {
  create(conversationId: string): Promise<ConversationSnapshot>;
  /**
   * 仅空闲清理：会话没有活动 run 时才清空消息与 journal；仍有活动 run 时 no-op。
   * 运行中的残留清理由以下原子认领负责，任何调用方不得在活动 run 期间强制清空。
   * 清空本身是一次状态迁移：递增 revision 并发布 snapshot change（同时入 journal），
   * 迟到/重连的订阅者按既有游标规则即可回放到清空后的状态；
   * 未来 SQLite 实现须在同一事务内完成删除与版本推进，并按会话串行。
   */
  clear(conversationId: string): Promise<void>;
  load(conversationId: string): Promise<ConversationSnapshot>;
  beginRun(conversationId: string, runId: string, userMessage: ConversationMessage): Promise<void>;
  appendUserMessage(conversationId: string, userMessage: ConversationMessage): Promise<void>;
  /**
   * 一次性答题运行的认领原语：在同一步内完成「有活动 run 时抛
   * 『当前回复尚未完成』→ 清空上一轮残留消息与 journal（revision 保持单调）→
   * 安装本轮 user/assistant 消息对」。检查、清理与安装是不可拆分的状态迁移：
   * 未来 SQLite 实现必须放在同一事务并按会话串行，绝不允许通过陈旧快照
   * 抹除在途运行。
   */
  beginEphemeralRun(
    conversationId: string,
    runId: string,
    userMessage: ConversationMessage,
  ): Promise<void>;
  appendEvent(event: Omit<ConversationEvent, "revision">): Promise<ConversationChange>;
  finishRun(
    conversationId: string,
    runId: string,
    status: "complete" | "interrupted",
  ): Promise<void>;
  readAfter(conversationId: string, revision: number): Promise<ConversationChange[]>;
  subscribe(listener: (change: ConversationChange) => void): () => void;
}

type Session = {
  snapshot: ConversationSnapshot;
  journal: ConversationChange[];
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

  async appendEvent(event: Omit<ConversationEvent, "revision">): Promise<ConversationChange> {
    const session = this.requireSession(event.conversationId);
    if (session.snapshot.activeRunId !== event.runId) throw new Error("会话没有匹配的活动 run");
    const stored: ConversationEvent = { ...event, revision: ++session.snapshot.revision };
    if (stored.chunk.type === "text-delta") {
      const message = session.snapshot.messages.find((item) => item.id === event.runId);
      if (message) message.text += stored.chunk.delta;
    }
    const change: ConversationChange = { type: "event", event: stored };
    this.publish(change, session);
    return change;
  }

  async finishRun(
    conversationId: string,
    runId: string,
    status: "complete" | "interrupted",
  ): Promise<void> {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeRunId !== runId) return;
    const message = session.snapshot.messages.find((item) => item.id === runId);
    if (!message) return;
    message.status = status;
    delete session.snapshot.activeRunId;
    session.snapshot.revision += 1;
    this.publish(
      {
        type: "run-finished",
        conversationId,
        revision: session.snapshot.revision,
        runId,
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

export function createUserMessage(
  id: string,
  request: ConversationSendRequest,
): ConversationMessage {
  return {
    id,
    role: "user",
    text: request.text,
    images: request.images.map((image) => ({ ...image })),
    status: "complete",
  };
}
