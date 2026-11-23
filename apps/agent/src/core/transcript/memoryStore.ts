/** 进程内 transcript 仓储；不记录 Agent 事件事实。 */
import type {
  ConversationMessage,
  ConversationMessagePart,
  ConversationSessionScope,
  ConversationSnapshot,
} from "@answra/shared";
import type { AgentStreamEvent, TurnOutcome } from "@answra/shared/schema";
import { compactionBoundaries } from "./contextBoundary";
import { cloneContextCheckpoint } from "./contextCheckpoint";
import type { ContextState } from "./contextState";
import type {
  ConversationSessionMetadata,
  ConversationSessionSeed,
  ConversationStore,
  ConversationStoreMutation,
  HandoffMessageInput,
  SessionTurnStartInput,
} from "./store";

export interface ConversationSessionRecord {
  snapshot: ConversationSnapshot;
  seed?: ConversationSessionSeed;
  contextState?: ContextState;
  metadata?: ConversationSessionMetadata;
  createdAt: string;
  updatedAt: string;
}

type Session = ConversationSessionRecord;

const MAX_HANDOFF_TASK_CHARS = 32_000;

export class MemoryConversationStore implements ConversationStore {
  protected readonly sessions = new Map<string, Session>();

  async create(
    conversationId: string,
    seed?: ConversationSessionSeed,
    metadata?: ConversationSessionMetadata,
  ): Promise<ConversationSnapshot> {
    const existing = this.sessions.get(conversationId);
    // 已存在会话的 Bot 归属是既有事实；create 只做读取，不写入新 seed。
    if (existing) return snapshotOf(existing);
    const now = new Date().toISOString();
    const session: Session = {
      snapshot: {
        conversationId,
        lastSeq: 0,
        messages: [],
        ...(seed ? seedSnapshot(seed) : {}),
      },
      ...(seed ? { seed: cloneSeed(seed) } : {}),
      ...(metadata ? { metadata: cloneMetadata(metadata) } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(conversationId, session);
    await this.afterMutation(conversationId, { kind: "created" });
    return snapshotOf(session);
  }

  async scopeOf(conversationId: string): Promise<ConversationSessionScope | undefined> {
    return this.sessions.get(conversationId)?.metadata?.scope;
  }

  async load(conversationId: string): Promise<ConversationSnapshot> {
    return snapshotOf(this.requireSession(conversationId));
  }

  async clear(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session || session.snapshot.activeMessageId) return;
    session.contextState = undefined;
    session.snapshot = {
      conversationId,
      // 清空会同时清空条目，seq 从 1 重新开始；游标必须归零，否则新事实会被旧游标吞掉。
      lastSeq: 0,
      messages: [],
      ...(session.seed ? seedSnapshot(session.seed) : {}),
    };
    await this.afterMutation(conversationId, { kind: "cleared" });
  }

  async advanceLastSeq(conversationId: string, sequence: number): Promise<void> {
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new Error("会话 durable 游标必须是非负整数");
    }
    const session = this.requireSession(conversationId);
    if (sequence <= session.snapshot.lastSeq) return;
    session.snapshot = { ...session.snapshot, lastSeq: sequence };
  }

  async beginSessionTurn(conversationId: string, input: SessionTurnStartInput): Promise<void> {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeMessageId) throw new Error("当前回复尚未完成");
    if (input.userMessage === undefined && session.snapshot.messages.length > 0) {
      const last = session.snapshot.messages.at(-1);
      if (last?.role !== "user" || last.status !== "complete")
        throw new Error("没有可回复的用户消息");
    }
    const previous = cloneRecord(session);
    if (input.userMessage !== undefined && input.userMessage.role !== "user")
      throw new Error("run 必须从用户消息开始");
    const messages = session.snapshot.messages.map(cloneMessage);
    if (input.userMessage !== undefined) messages.push(normalizeUserMessage(input.userMessage));
    const placeholder = createAssistantMessage(input.messageId, input.authorAgentId);
    const anchor =
      input.afterMessageId === undefined
        ? -1
        : messages.findIndex((message) => message.id === input.afterMessageId);
    if (anchor >= 0) messages.splice(anchor + 1, 0, placeholder);
    else messages.push(placeholder);
    session.snapshot = {
      ...session.snapshot,
      messages,
      activeMessageId: input.messageId,
      activeTurnId: input.turnId,
      ...(input.authorAgentId ? { activeAgentId: input.authorAgentId } : {}),
    };
    await this.commitMutation(conversationId, previous, {
      kind: "run-started",
      dirtyMessageIds: [input.messageId, ...(input.userMessage ? [input.userMessage.id] : [])],
    });
  }

  /** 内存实现自己就是事实来源，没有需要重建的消息视图。 */
  async refresh(_conversationId: string): Promise<void> {}

  async beginSessionAssistant(
    conversationId: string,
    messageId: string,
    authorAgentId: string,
  ): Promise<void> {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeMessageId) throw new Error("当前回复尚未完成");
    const last = session.snapshot.messages.at(-1);
    if (
      last?.role !== "assistant" ||
      last.status !== "complete" ||
      last.audience?.kind !== "bot" ||
      last.audience.agentId !== authorAgentId
    ) {
      throw new Error("没有可接管给当前 Bot 的交接消息");
    }
    const previous = cloneRecord(session);
    session.snapshot = {
      ...session.snapshot,
      messages: [...session.snapshot.messages, createAssistantMessage(messageId, authorAgentId)],
      activeMessageId: messageId,
      activeAgentId: authorAgentId,
    };
    await this.commitMutation(conversationId, previous, {
      kind: "run-started",
      dirtyMessageIds: [messageId],
    });
  }

  async finishSessionTurn(conversationId: string, turnId: string): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session || session.snapshot.activeTurnId !== turnId) return;
    session.snapshot = {
      ...session.snapshot,
      activeTurnId: undefined,
      activeMessageId: undefined,
    };
    await this.afterMutation(conversationId, { kind: "changed" });
  }

  async applySessionStreamEvent(
    conversationId: string,
    messageId: string,
    event: AgentStreamEvent,
  ): Promise<void> {
    const session = this.requireSession(conversationId);
    const message = session.snapshot.messages.find((item) => item.id === messageId);
    if (!message) throw new Error("会话没有匹配的助手消息");
    const nextMessage = applyTranscriptEvent(message, message.parts ?? [], event);
    if (!nextMessage) return;
    session.snapshot = {
      ...session.snapshot,
      messages: session.snapshot.messages.map((item) =>
        item.id === messageId ? nextMessage : item,
      ),
    };
  }

  async finishSessionAssistant(
    conversationId: string,
    messageId: string,
    outcome: TurnOutcome,
  ): Promise<void> {
    this.finishAssistant(conversationId, messageId, outcome);
    await this.afterMutation(conversationId, {
      kind: "run-finished",
      dirtyMessageIds: [messageId],
    });
  }

  async appendHandoffMessage(
    conversationId: string,
    handoff: HandoffMessageInput,
  ): Promise<ConversationSnapshot> {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeMessageId) throw new Error("当前回复尚未完成");
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
    await this.afterMutation(conversationId, {
      kind: "changed",
      dirtyMessageIds: [handoff.id],
    });
    return snapshotOf(session);
  }

  async setActiveAgent(conversationId: string, agentId: string): Promise<void> {
    const session = this.requireSession(conversationId);
    assertParticipant(session, agentId);
    session.snapshot = { ...session.snapshot, activeAgentId: agentId };
    await this.afterMutation(conversationId, { kind: "changed" });
  }

  async appendUserMessage(
    conversationId: string,
    userMessage: ConversationMessage,
  ): Promise<ConversationSnapshot> {
    const session = this.requireSession(conversationId);
    if (session.snapshot.activeMessageId) throw new Error("当前回复尚未完成");
    if (userMessage.role !== "user" || userMessage.status !== "complete")
      throw new Error("仅可追加已完成的用户消息");
    session.snapshot = {
      ...session.snapshot,
      messages: [...session.snapshot.messages, normalizeUserMessage(userMessage)],
    };
    await this.afterMutation(conversationId, {
      kind: "changed",
      dirtyMessageIds: [userMessage.id],
    });
    return snapshotOf(session);
  }

  async loadContextState(conversationId: string): Promise<ContextState | undefined> {
    const state = this.requireSession(conversationId).contextState;
    return state ? cloneContextState(state) : undefined;
  }

  async saveContextState(conversationId: string, state: ContextState): Promise<void> {
    const session = this.requireSession(conversationId);
    // 上下文检查点是独立元数据；摘要压缩必须在活动 run 内完成写入。
    session.contextState = cloneContextState(state);
    await this.afterMutation(conversationId, { kind: "changed" });
  }

  async close(): Promise<void> {}

  private finishAssistant(conversationId: string, messageId: string, outcome: TurnOutcome): void {
    const session = this.requireSession(conversationId);
    if (!session.snapshot.messages.some((message) => message.id === messageId)) return;
    session.snapshot = {
      ...session.snapshot,
      ...(session.snapshot.activeMessageId === messageId ? { activeMessageId: undefined } : {}),
      messages: session.snapshot.messages.map((message) =>
        message.id === messageId
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

  private async commitMutation(
    conversationId: string,
    previous: ConversationSessionRecord,
    mutation: ConversationStoreMutation,
  ): Promise<void> {
    try {
      await this.afterMutation(conversationId, mutation);
    } catch (error) {
      // 冲突处理会主动丢弃内存会话，不能在这里把它复活。
      if (this.sessions.has(conversationId)) this.sessions.set(conversationId, previous);
      throw error;
    }
  }

  protected async afterMutation(
    conversationId: string,
    _mutation: ConversationStoreMutation,
  ): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (session) session.updatedAt = new Date().toISOString();
  }

  protected restoreSession(record: ConversationSessionRecord): void {
    this.sessions.set(record.snapshot.conversationId, cloneRecord(record));
  }

  private requireSession(conversationId: string): Session {
    const session = this.sessions.get(conversationId);
    if (!session) throw new Error("会话不存在");
    return session;
  }
}

function cloneMetadata(metadata: ConversationSessionMetadata): ConversationSessionMetadata {
  return {
    scope: metadata.scope,
    ...(metadata.workspaceRoot === undefined ? {} : { workspaceRoot: metadata.workspaceRoot }),
    ...(metadata.title === undefined ? {} : { title: metadata.title }),
  };
}

function cloneRecord(record: ConversationSessionRecord): ConversationSessionRecord {
  return {
    snapshot: cloneSnapshot(record.snapshot),
    ...(record.seed ? { seed: cloneSeed(record.seed) } : {}),
    ...(record.contextState ? { contextState: cloneContextState(record.contextState) } : {}),
    ...(record.metadata ? { metadata: cloneMetadata(record.metadata) } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function settleInterruptedParts(
  parts: ConversationMessagePart[] | undefined,
  outcome: TurnOutcome,
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

function assertParticipant(session: Session, agentId: string): void {
  const participants = session.snapshot.participantAgentIds;
  if (participants && !participants.includes(agentId))
    throw new Error(`Bot 不在当前会话参与者中：${agentId}`);
}

function snapshotOf(session: Session): ConversationSnapshot {
  const compaction = session.contextState?.compaction;
  const boundaries = compactionBoundaries(session.contextState);
  return cloneSnapshot({
    ...session.snapshot,
    ...(compaction ? { contextCompaction: { ...compaction } } : {}),
    ...(boundaries.length > 0 ? { contextCompactionBoundaries: boundaries } : {}),
    ...(session.contextState?.usage ? { contextUsage: { ...session.contextState.usage } } : {}),
    ...(session.contextState?.pruning
      ? { contextPruning: { ...session.contextState.pruning } }
      : {}),
  });
}

function cloneContextState(state: ContextState): ContextState {
  return {
    checkpoints: state.checkpoints.map(cloneContextCheckpoint),
    ...(state.compaction ? { compaction: { ...state.compaction } } : {}),
    ...(state.usageAnchor ? { usageAnchor: { ...state.usageAnchor } } : {}),
    ...(state.usage ? { usage: { ...state.usage } } : {}),
    ...(state.pruning ? { pruning: { ...state.pruning } } : {}),
    ...(state.prunedToolCallIds ? { prunedToolCallIds: [...state.prunedToolCallIds] } : {}),
    ...(state.compactionFailureCount === undefined
      ? {}
      : { compactionFailureCount: state.compactionFailureCount }),
    ...(state.compactionRetryAt === undefined
      ? {}
      : { compactionRetryAt: state.compactionRetryAt }),
  };
}

function cloneSnapshot(snapshot: ConversationSnapshot): ConversationSnapshot {
  return {
    ...snapshot,
    messages: snapshot.messages.map(cloneMessage),
    ...(snapshot.contextCompactionBoundaries === undefined
      ? {}
      : {
          contextCompactionBoundaries: snapshot.contextCompactionBoundaries.map((boundary) => ({
            ...boundary,
          })),
        }),
  };
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
