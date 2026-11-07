/** Conversation transcript 的进程内仓储；不记录 Agent 事件事实或事件 journal。 */
import type { ConversationMessage, ConversationSnapshot } from "@answra/shared";
import type { AgentStreamEvent, RunOutcome } from "@answra/shared/schema";
import type { ConversationStore } from "./store";

type Session = { snapshot: ConversationSnapshot };

export class MemoryConversationStore implements ConversationStore {
  private readonly sessions = new Map<string, Session>();

  async create(conversationId: string): Promise<ConversationSnapshot> {
    const existing = this.sessions.get(conversationId);
    if (existing) return cloneSnapshot(existing.snapshot);
    const session = { snapshot: { conversationId, revision: 0, messages: [] } } satisfies Session;
    this.sessions.set(conversationId, session);
    return cloneSnapshot(session.snapshot);
  }

  async load(conversationId: string): Promise<ConversationSnapshot> {
    return cloneSnapshot(this.requireSession(conversationId).snapshot);
  }

  async clear(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session || session.snapshot.activeRunId) return;
    session.snapshot = {
      conversationId,
      revision: session.snapshot.revision + 1,
      messages: [],
    };
  }

  async beginRun(
    conversationId: string,
    runId: string,
    userMessage: ConversationMessage,
  ): Promise<void> {
    this.beginMessages(conversationId, runId, userMessage, true);
  }

  async beginReplyRun(conversationId: string, runId: string): Promise<ConversationMessage> {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeRunId) throw new Error("当前回复尚未完成");
    const last = session.snapshot.messages.at(-1);
    if (last?.role !== "user" || last.status !== "complete")
      throw new Error("没有可回复的用户消息");
    const assistant = createAssistantMessage(runId);
    session.snapshot = {
      ...session.snapshot,
      messages: [...session.snapshot.messages, assistant],
      activeRunId: runId,
      revision: session.snapshot.revision + 1,
    };
    return cloneMessage(last);
  }

  async appendUserMessage(
    conversationId: string,
    userMessage: ConversationMessage,
  ): Promise<ConversationSnapshot> {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeRunId) throw new Error("当前回复尚未完成");
    if (userMessage.role !== "user" || userMessage.status !== "complete")
      throw new Error("仅可追加已完成的用户消息");
    session.snapshot = {
      ...session.snapshot,
      messages: [...session.snapshot.messages, cloneMessage(userMessage)],
      revision: session.snapshot.revision + 1,
    };
    return cloneSnapshot(session.snapshot);
  }

  async beginEphemeralRun(
    conversationId: string,
    runId: string,
    userMessage: ConversationMessage,
  ): Promise<void> {
    this.beginMessages(conversationId, runId, userMessage, false);
  }

  async applyStreamEvent(
    conversationId: string,
    runId: string,
    event: AgentStreamEvent,
  ): Promise<void> {
    if (event.type !== "text-delta") return;
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeRunId !== runId) throw new Error("会话没有匹配的活动 run");
    session.snapshot = {
      ...session.snapshot,
      messages: session.snapshot.messages.map((message) =>
        message.id === runId ? { ...message, text: message.text + event.delta } : message,
      ),
      revision: session.snapshot.revision + 1,
    };
  }

  async finishRun(conversationId: string, runId: string, outcome: RunOutcome): Promise<void> {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeRunId !== runId) return;
    session.snapshot = {
      ...session.snapshot,
      activeRunId: undefined,
      messages: session.snapshot.messages.map((message) =>
        message.id === runId
          ? {
              ...message,
              status:
                outcome === "completed"
                  ? "complete"
                  : outcome === "failed"
                    ? "failed"
                    : "interrupted",
            }
          : message,
      ),
      revision: session.snapshot.revision + 1,
    };
  }

  private beginMessages(
    conversationId: string,
    runId: string,
    userMessage: ConversationMessage,
    preserveHistory: boolean,
  ): void {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeRunId) throw new Error("当前回复尚未完成");
    if (userMessage.role !== "user") throw new Error("run 必须从用户消息开始");
    session.snapshot = {
      conversationId,
      revision: session.snapshot.revision + 1,
      messages: [
        ...(preserveHistory ? session.snapshot.messages.map(cloneMessage) : []),
        cloneMessage(userMessage),
        createAssistantMessage(runId),
      ],
      activeRunId: runId,
    };
  }

  private requireSession(conversationId: string): Session {
    const session = this.sessions.get(conversationId);
    if (!session) throw new Error("会话不存在");
    return session;
  }
}

function createAssistantMessage(runId: string): ConversationMessage {
  return { id: runId, role: "assistant", text: "", images: [], status: "streaming" };
}

function cloneSnapshot(snapshot: ConversationSnapshot): ConversationSnapshot {
  return { ...snapshot, messages: snapshot.messages.map(cloneMessage) };
}

function cloneMessage(message: ConversationMessage): ConversationMessage {
  return { ...message, images: [...message.images] };
}
