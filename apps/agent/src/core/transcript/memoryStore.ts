/** 进程内 transcript 仓储；不记录 Agent 事件事实或事件 journal。 */
import type {
  ConversationMessage,
  ConversationMessagePart,
  ConversationSnapshot,
} from "@answra/shared";
import type { AgentEventEnvelope, AgentStreamEvent, RunOutcome } from "@answra/shared/schema";
import type { ConversationSessionSeed, ConversationStore, HandoffMessageInput } from "./store";

type Session = { snapshot: ConversationSnapshot; seed?: ConversationSessionSeed };

const MAX_HANDOFF_TASK_CHARS = 32_000;

export class MemoryConversationStore implements ConversationStore {
  private readonly sessions = new Map<string, Session>();

  async create(
    conversationId: string,
    seed?: ConversationSessionSeed,
  ): Promise<ConversationSnapshot> {
    const existing = this.sessions.get(conversationId);
    if (existing) {
      if (seed) applySeed(existing, seed);
      return cloneSnapshot(existing.snapshot);
    }
    const session: Session = {
      snapshot: {
        conversationId,
        eventRevision: 0,
        messages: [],
        ...(seed ? seedSnapshot(seed) : {}),
      },
      ...(seed ? { seed: cloneSeed(seed) } : {}),
    };
    this.sessions.set(conversationId, session);
    return cloneSnapshot(session.snapshot);
  }

  async load(conversationId: string): Promise<ConversationSnapshot> {
    return cloneSnapshot(this.requireSession(conversationId).snapshot);
  }

  async clear(conversationId: string, eventRevision = 0): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session || session.snapshot.activeRunId) return;
    session.snapshot = {
      conversationId,
      eventRevision: Math.max(session.snapshot.eventRevision, eventRevision),
      messages: [],
      ...(session.seed ? seedSnapshot(session.seed) : {}),
    };
  }

  async beginRun(
    conversationId: string,
    runId: string,
    userMessage: ConversationMessage,
    eventRevision = 0,
    authorAgentId?: string,
  ): Promise<void> {
    this.beginMessages(conversationId, runId, userMessage, true, eventRevision, authorAgentId);
  }

  async beginReplyRun(
    conversationId: string,
    runId: string,
    eventRevision = 0,
    authorAgentId?: string,
  ): Promise<ConversationMessage> {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeRunId) throw new Error("当前回复尚未完成");
    const last = session.snapshot.messages.at(-1);
    if (last?.role !== "user" || last.status !== "complete")
      throw new Error("没有可回复的用户消息");
    const assistant = createAssistantMessage(runId, authorAgentId);
    session.snapshot = {
      ...session.snapshot,
      messages: [...session.snapshot.messages, assistant],
      activeRunId: runId,
      eventRevision: Math.max(session.snapshot.eventRevision, eventRevision),
      ...(authorAgentId ? { activeAgentId: authorAgentId } : {}),
    };
    return cloneMessage(last);
  }

  async beginHandoffRun(
    conversationId: string,
    runId: string,
    targetAgentId: string,
    eventRevision = 0,
  ): Promise<ConversationMessage> {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeRunId) throw new Error("当前回复尚未完成");
    const last = session.snapshot.messages.at(-1);
    if (
      last?.role !== "assistant" ||
      last.status !== "complete" ||
      last.audience?.kind !== "bot" ||
      last.audience.agentId !== targetAgentId
    )
      throw new Error("没有可接管给当前 Bot 的交接消息");
    const assistant = createAssistantMessage(runId, targetAgentId);
    session.snapshot = {
      ...session.snapshot,
      messages: [...session.snapshot.messages, assistant],
      activeRunId: runId,
      eventRevision: Math.max(session.snapshot.eventRevision, eventRevision),
      activeAgentId: targetAgentId,
    };
    return cloneMessage(last);
  }

  async appendHandoffMessage(
    conversationId: string,
    handoff: HandoffMessageInput,
  ): Promise<ConversationSnapshot> {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeRunId) throw new Error("当前回复尚未完成");
    if (handoff.fromAgentId === handoff.toAgentId) throw new Error("交接目标不能是当前 Bot");
    if (!handoff.task.trim() || handoff.task.length > MAX_HANDOFF_TASK_CHARS)
      throw new Error("交接内容无效或过长");
    if (session.snapshot.activeAgentId !== handoff.fromAgentId)
      throw new Error("交接来源必须是当前 Bot");
    assertParticipant(session, handoff.fromAgentId);
    assertParticipant(session, handoff.toAgentId);
    const message: ConversationMessage = {
      id: handoff.id,
      role: "assistant",
      authorAgentId: handoff.fromAgentId,
      audience: { kind: "bot", agentId: handoff.toAgentId },
      text: handoff.task,
      images: [],
      status: "complete",
      parts: [],
    };
    session.snapshot = {
      ...session.snapshot,
      messages: [...session.snapshot.messages, message],
      activeAgentId: handoff.toAgentId,
    };
    return cloneSnapshot(session.snapshot);
  }

  async setActiveAgent(conversationId: string, agentId: string): Promise<void> {
    const session = this.requireSession(conversationId);
    assertParticipant(session, agentId);
    session.snapshot = { ...session.snapshot, activeAgentId: agentId };
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
      messages: [...session.snapshot.messages, normalizeUserMessage(userMessage)],
    };
    return cloneSnapshot(session.snapshot);
  }

  async beginEphemeralRun(
    conversationId: string,
    runId: string,
    userMessage: ConversationMessage,
    eventRevision = 0,
    authorAgentId?: string,
  ): Promise<void> {
    this.beginMessages(conversationId, runId, userMessage, false, eventRevision, authorAgentId);
  }

  async applyAgentEvent(conversationId: string, envelope: AgentEventEnvelope): Promise<void> {
    const { event, runId, aggregateRevision } = envelope;
    const session = this.requireSession(conversationId);
    if (envelope.conversationId !== conversationId) throw new Error("事件不属于当前会话");
    if (aggregateRevision <= session.snapshot.eventRevision) return;
    if (event.type === "run-state-changed") {
      const outcome = runOutcomeForState(event.state);
      if (outcome) {
        this.finishRun(conversationId, runId, outcome, aggregateRevision);
        return;
      }
      if (session.snapshot.activeRunId === runId)
        session.snapshot = { ...session.snapshot, eventRevision: aggregateRevision };
      return;
    }
    if (session.snapshot.activeRunId !== runId) return;
    if (
      event.type === "step-started" ||
      event.type === "step-finished" ||
      event.type === "part-state-changed"
    ) {
      session.snapshot = { ...session.snapshot, eventRevision: aggregateRevision };
      return;
    }
    this.applyStreamEvent(conversationId, runId, event);
    session.snapshot = { ...session.snapshot, eventRevision: aggregateRevision };
  }

  private applyStreamEvent(conversationId: string, runId: string, event: AgentStreamEvent): void {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeRunId !== runId) throw new Error("会话没有匹配的活动 run");
    const message = session.snapshot.messages.find((item) => item.id === runId);
    if (!message) throw new Error("会话没有匹配的助手消息");
    const nextMessage = applyTranscriptEvent(message, message.parts ?? [], event);
    if (!nextMessage) return;
    session.snapshot = {
      ...session.snapshot,
      messages: session.snapshot.messages.map((item) => (item.id === runId ? nextMessage : item)),
    };
  }

  private finishRun(
    conversationId: string,
    runId: string,
    outcome: RunOutcome,
    eventRevision = 0,
  ): void {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeRunId !== runId) return;
    session.snapshot = {
      ...session.snapshot,
      eventRevision,
      activeRunId: undefined,
      messages: session.snapshot.messages.map((message) =>
        message.id === runId
          ? {
              ...message,
              parts: settleInterruptedParts(message.parts, outcome),
              status:
                outcome === "completed"
                  ? "complete"
                  : outcome === "failed"
                    ? "failed"
                    : "interrupted",
            }
          : message,
      ),
    };
  }

  private beginMessages(
    conversationId: string,
    runId: string,
    userMessage: ConversationMessage,
    preserveHistory: boolean,
    eventRevision: number,
    authorAgentId?: string,
  ): void {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeRunId) throw new Error("当前回复尚未完成");
    if (userMessage.role !== "user") throw new Error("run 必须从用户消息开始");
    session.snapshot = {
      conversationId,
      eventRevision: Math.max(session.snapshot.eventRevision, eventRevision),
      messages: [
        ...(preserveHistory ? session.snapshot.messages.map(cloneMessage) : []),
        normalizeUserMessage(userMessage),
        createAssistantMessage(runId, authorAgentId),
      ],
      activeRunId: runId,
      ...(session.seed ? seedSnapshot(session.seed) : {}),
      ...(authorAgentId ? { activeAgentId: authorAgentId } : {}),
    };
  }

  private requireSession(conversationId: string): Session {
    const session = this.sessions.get(conversationId);
    if (!session) throw new Error("会话不存在");
    return session;
  }
}

function settleInterruptedParts(
  parts: ConversationMessagePart[] | undefined,
  outcome: RunOutcome,
): ConversationMessagePart[] | undefined {
  if (!parts || outcome === "completed") return parts;
  const state = outcome === "failed" ? "failed" : "interrupted";
  return parts.map((part) => {
    if (part.kind === "tool") {
      if (part.state === "completed" || part.state === "failed" || part.state === "denied")
        return part;
      return { ...part, state };
    }
    if (part.state === "completed" || part.state === "failed" || part.state === "interrupted")
      return part;
    return { ...part, state };
  });
}

function runOutcomeForState(
  state: Extract<AgentEventEnvelope["event"], { type: "run-state-changed" }>["state"],
): "completed" | "failed" | "aborted" | "superseded" | undefined {
  switch (state) {
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

function createAssistantMessage(runId: string, authorAgentId?: string): ConversationMessage {
  return {
    id: runId,
    role: "assistant",
    ...(authorAgentId ? { authorAgentId } : {}),
    audience: { kind: "user" },
    text: "",
    images: [],
    status: "streaming",
    parts: [],
  };
}

function normalizeUserMessage(message: ConversationMessage): ConversationMessage {
  return { ...cloneMessage(message), audience: { kind: "user" } };
}

function seedSnapshot(
  seed: ConversationSessionSeed,
): Pick<ConversationSnapshot, "activeAgentId" | "participantAgentIds" | "bots"> {
  return {
    activeAgentId: seed.activeAgentId,
    participantAgentIds: [...seed.participantAgentIds],
    ...(seed.bots ? { bots: seed.bots.map((bot) => ({ ...bot })) } : {}),
  };
}

function cloneSeed(seed: ConversationSessionSeed): ConversationSessionSeed {
  return {
    activeAgentId: seed.activeAgentId,
    participantAgentIds: [...seed.participantAgentIds],
    ...(seed.bots ? { bots: seed.bots.map((bot) => ({ ...bot })) } : {}),
  };
}

function applySeed(session: Session, seed: ConversationSessionSeed): void {
  session.seed = cloneSeed(seed);
  session.snapshot = {
    ...session.snapshot,
    ...(!session.snapshot.activeAgentId ? { activeAgentId: seed.activeAgentId } : {}),
    ...(!session.snapshot.participantAgentIds
      ? { participantAgentIds: [...seed.participantAgentIds] }
      : {}),
    ...(!session.snapshot.bots && seed.bots ? { bots: seed.bots.map((bot) => ({ ...bot })) } : {}),
  };
}

function assertParticipant(session: Session, agentId: string): void {
  const participants = session.snapshot.participantAgentIds;
  if (participants && !participants.includes(agentId))
    throw new Error(`Bot 不在当前会话参与者中：${agentId}`);
}

function cloneSnapshot(snapshot: ConversationSnapshot): ConversationSnapshot {
  return { ...snapshot, messages: snapshot.messages.map(cloneMessage) };
}

function cloneMessage(message: ConversationMessage): ConversationMessage {
  return {
    ...message,
    images: [...message.images],
    ...(message.parts ? { parts: message.parts.map((part) => ({ ...part })) } : {}),
  };
}

function applyTranscriptEvent(
  message: ConversationMessage,
  parts: ConversationMessagePart[],
  event: AgentStreamEvent,
): ConversationMessage | undefined {
  switch (event.type) {
    case "text-start":
      return upsertPart(message, parts, {
        id: event.partId,
        kind: "text",
        text: "",
        state: "started",
      });
    case "text-delta": {
      const current = findPart(parts, event.partId, "text");
      return upsertPart({ ...message, text: message.text + event.delta }, parts, {
        id: event.partId,
        kind: "text",
        text: (current?.text ?? "") + event.delta,
        state: "streaming",
      });
    }
    case "text-end": {
      const current = findPart(parts, event.partId, "text");
      if (!current) return undefined;
      return upsertPart(message, parts, { ...current, state: "completed" });
    }
    case "reasoning-start":
      return upsertPart(message, parts, {
        id: event.partId,
        kind: "reasoning",
        text: "",
        state: "started",
      });
    case "reasoning-delta": {
      const current = findPart(parts, event.partId, "reasoning");
      return upsertPart({ ...message, reasoning: (message.reasoning ?? "") + event.delta }, parts, {
        id: event.partId,
        kind: "reasoning",
        text: (current?.text ?? "") + event.delta,
        state: "streaming",
      });
    }
    case "reasoning-end": {
      const current = findPart(parts, event.partId, "reasoning");
      if (!current) return undefined;
      return upsertPart(message, parts, { ...current, state: "completed" });
    }
    case "tool-input-start":
      return upsertPart(message, parts, {
        id: event.toolCallId,
        kind: "tool",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(event.title ? { title: event.title } : {}),
        state: "input-streaming",
      });
    case "tool-input-delta": {
      const current = findPart(parts, event.toolCallId, "tool");
      if (!current) return undefined;
      return upsertPart(message, parts, {
        ...current,
        inputText: (current.inputText ?? "") + event.delta,
        state: "input-streaming",
      });
    }
    case "tool-input-end": {
      const current = findPart(parts, event.toolCallId, "tool");
      if (!current) return undefined;
      return upsertPart(message, parts, { ...current, state: "pending" });
    }
    case "tool-call": {
      const current = findPart(parts, event.toolCallId, "tool");
      return upsertPart(message, parts, {
        id: event.toolCallId,
        kind: "tool",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(current?.title ? { title: current.title } : {}),
        ...(current?.inputText ? { inputText: current.inputText } : {}),
        state: "pending",
        input: event.input,
      });
    }
    case "tool-approval-request": {
      const current = findPart(parts, event.toolCallId, "tool");
      return upsertPart(message, parts, {
        id: event.toolCallId,
        kind: "tool",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        state: "awaiting-approval",
        input: event.input,
        ...(current?.title ? { title: current.title } : {}),
      });
    }
    case "tool-execution-started": {
      const current = findPart(parts, event.toolCallId, "tool");
      if (!current) return undefined;
      return upsertPart(message, parts, { ...current, state: "running" });
    }
    case "tool-execution-finished": {
      const current = findPart(parts, event.toolCallId, "tool");
      if (!current) return undefined;
      return upsertPart(
        message,
        parts,
        event.result.success
          ? { ...current, state: "completed", output: event.result.output }
          : { ...current, state: "failed", errorText: event.result.errorText },
      );
    }
    case "tool-result": {
      const current = findPart(parts, event.toolCallId, "tool");
      if (!current) return undefined;
      return upsertPart(message, parts, { ...current, state: "completed", output: event.output });
    }
    case "tool-error": {
      const current = findPart(parts, event.toolCallId, "tool");
      if (!current) return undefined;
      return upsertPart(message, parts, {
        ...current,
        state: "failed",
        errorText: event.errorText,
      });
    }
    case "tool-output-denied": {
      const current = findPart(parts, event.toolCallId, "tool");
      if (!current) return undefined;
      return upsertPart(message, parts, { ...current, state: "denied" });
    }
    default:
      return undefined;
  }
}

function findPart<K extends ConversationMessagePart["kind"]>(
  parts: ConversationMessagePart[],
  id: string,
  kind: K,
): Extract<ConversationMessagePart, { kind: K }> | undefined {
  const part = parts.find((item) => item.id === id);
  return part?.kind === kind ? (part as Extract<ConversationMessagePart, { kind: K }>) : undefined;
}

function upsertPart(
  message: ConversationMessage,
  parts: ConversationMessagePart[],
  nextPart: ConversationMessagePart,
): ConversationMessage {
  const index = parts.findIndex((part) => part.id === nextPart.id);
  const nextParts = [...parts];
  if (index < 0) nextParts.push(nextPart);
  else nextParts[index] = nextPart;
  return { ...message, parts: nextParts };
}
