/** 会话记录 payload：SQLite 行与旧 JSON 文件共用的 schema、恢复和摘要投影。 */
import type { ConversationMessage, ConversationSessionSummary } from "@answra/shared";
import {
  contextCompactionSchema,
  contextPruningSchema,
  contextUsageSchema,
  conversationMessageSchema,
  conversationSessionScopeSchema,
  conversationSnapshotSchema,
} from "@answra/shared/schema";
import { z } from "zod";
import { cloneContextCheckpoint } from "../contextCheckpoint";
import type { ContextState } from "../contextState";
import type { ConversationSessionRecord } from "../memoryStore";
import type { ConversationSessionMetadata } from "../store";
import { restoreContextState, restoreConversationSnapshot } from "./restore";

const retainedUserMessageSchema = conversationMessageSchema.refine(
  (message) => message.role === "user",
  { message: "压缩保留消息必须是用户消息" },
);

const checkpointSchema = z.strictObject({
  summary: z.string(),
  throughMessageId: z.string(),
  createdAt: z.string().datetime(),
  messageCount: z.number().int().nonnegative(),
  retainedUserMessages: z.array(retainedUserMessageSchema).optional(),
  instructions: z.string().optional(),
});

const usageAnchorSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

const contextStateSchema = z.strictObject({
  checkpoints: z.array(checkpointSchema),
  compaction: contextCompactionSchema.optional(),
  usageAnchor: usageAnchorSchema.optional(),
  usage: contextUsageSchema.optional(),
  pruning: contextPruningSchema.optional(),
  prunedToolCallIds: z.array(z.string()).optional(),
  compactionFailureCount: z.number().int().nonnegative().optional(),
  compactionRetryAt: z.string().datetime().optional(),
});

const botSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  role: z.string(),
});

const seedSchema = z.strictObject({
  activeAgentId: z.string(),
  participantAgentIds: z.array(z.string()),
  bots: z.array(botSchema).optional(),
});

const stateSnapshotSchema = conversationSnapshotSchema.omit({
  messages: true,
  activeTurnId: true,
  activeMessageId: true,
  eventRevision: true,
  lastSeq: true,
});

/** 旧 JSON 全量记录从没有 durable 游标；读取时按 0 恢复。 */
const legacySnapshotSchema = conversationSnapshotSchema
  .omit({ lastSeq: true })
  /** 更早的记录把活动消息存成 `activeRunId`；只做读入兼容，恢复时丢弃。 */
  .extend({ activeRunId: z.string().optional() });

export const sessionStatePayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  conversationId: z.string(),
  snapshot: stateSnapshotSchema,
  contextState: contextStateSchema.optional(),
  seed: seedSchema.optional(),
});

export const sessionRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  conversationId: z.string(),
  scope: conversationSessionScopeSchema,
  workspaceRoot: z.string().optional(),
  title: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  snapshot: legacySnapshotSchema,
  contextState: contextStateSchema.optional(),
  seed: seedSchema.optional(),
});

export type SessionStatePayload = z.infer<typeof sessionStatePayloadSchema>;
export type SessionRecordPayload = z.infer<typeof sessionRecordSchema>;

export interface StoredSessionState {
  state: SessionStatePayload;
  messages: readonly ConversationMessage[];
  metadata: ConversationSessionMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface SplitSessionRecord {
  state: SessionStatePayload;
  messages: readonly ConversationMessage[];
}

export function parseSessionRecord(value: unknown): SessionRecordPayload {
  return sessionRecordSchema.parse(value);
}

export function parseSessionStatePayload(value: unknown): SessionStatePayload {
  return sessionStatePayloadSchema.parse(value);
}

export function parseStoredMessage(value: unknown): ConversationMessage {
  return conversationMessageSchema.parse(value);
}

export function splitSessionRecord(record: ConversationSessionRecord): SplitSessionRecord {
  if (!record.metadata) throw new Error("会话缺少 metadata，拒绝持久化");
  const {
    messages,
    activeTurnId: _activeTurnId,
    activeMessageId: _activeMessageId,
    eventRevision: _eventRevision,
    lastSeq: _lastSeq,
    ...snapshot
  } = record.snapshot;
  return {
    state: {
      schemaVersion: 1,
      conversationId: record.snapshot.conversationId,
      snapshot,
      ...(record.contextState
        ? { contextState: toPersistedContextState(record.contextState) }
        : {}),
      ...(record.seed ? { seed: cloneSeed(record.seed) } : {}),
    },
    messages: messages.map(cloneMessage),
  };
}

export function splitLegacySessionRecord(record: SessionRecordPayload): SplitSessionRecord {
  const {
    messages,
    activeRunId: _activeRunId,
    activeTurnId: _activeTurnId,
    activeMessageId: _activeMessageId,
    eventRevision: _eventRevision,
    ...snapshot
  } = record.snapshot;
  return {
    state: {
      schemaVersion: 1,
      conversationId: record.conversationId,
      snapshot,
      ...(record.contextState
        ? { contextState: toPersistedContextState(record.contextState) }
        : {}),
      ...(record.seed ? { seed: cloneSeed(record.seed) } : {}),
    },
    messages: messages.map(cloneMessage),
  };
}

export function restoreStoredSession(stored: StoredSessionState): ConversationSessionRecord {
  return {
    snapshot: restoreConversationSnapshot({
      ...stored.state.snapshot,
      conversationId: stored.state.conversationId,
      eventRevision: 0,
      messages: stored.messages.map(cloneMessage),
    }),
    ...(stored.state.seed ? { seed: cloneSeed(stored.state.seed) } : {}),
    ...(stored.state.contextState
      ? { contextState: restoreContextState(stored.state.contextState) }
      : {}),
    metadata: cloneMetadata(stored.metadata),
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

export function mergeDraftMessage(
  stored: ConversationMessage,
  draft: ConversationMessage,
): ConversationMessage {
  if (draft.id !== stored.id || draft.role !== "assistant") {
    throw new Error("消息草稿与已存消息不匹配");
  }
  const { parts: _storedParts, reasoning: _storedReasoning, ...rest } = stored;
  return {
    ...rest,
    text: draft.text,
    images: [...draft.images],
    status: draft.status,
    ...(draft.parts === undefined ? {} : { parts: draft.parts.map(clonePart) }),
    ...(draft.reasoning === undefined ? {} : { reasoning: draft.reasoning }),
  };
}

export function summarizeSessionState(
  messages: readonly ConversationMessage[],
  explicitTitle?: string,
): { title: string; messageCount: number } {
  return {
    title: explicitTitle?.trim() || firstUserMessageTitle(messages) || "未命名会话",
    messageCount: messages.length,
  };
}

export function summarizeSessionRecord(record: SessionRecordPayload): ConversationSessionSummary {
  return {
    conversationId: record.conversationId,
    scope: record.scope,
    title: record.title?.trim() || firstUserMessageTitle(record.snapshot.messages) || "未命名会话",
    messageCount: record.snapshot.messages.length,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.workspaceRoot === undefined ? {} : { workspaceRoot: record.workspaceRoot }),
  };
}

function firstUserMessageTitle(
  messages: readonly { role: "user" | "assistant"; text: string }[],
): string | undefined {
  const text = messages.find((message) => message.role === "user")?.text.trim();
  if (!text) return undefined;
  const chars = Array.from(text);
  return chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : text;
}

function toPersistedContextState(
  state: ContextState,
): NonNullable<SessionRecordPayload["contextState"]> {
  const { prunedToolCallIds, ...rest } = state;
  return {
    ...rest,
    checkpoints: rest.checkpoints.map(cloneContextCheckpoint),
    ...(prunedToolCallIds ? { prunedToolCallIds: [...prunedToolCallIds] } : {}),
  };
}

function cloneSeed(seed: {
  activeAgentId: string;
  participantAgentIds: readonly string[];
  bots?: readonly { id: string; name: string; role: string }[];
}) {
  return {
    activeAgentId: seed.activeAgentId,
    participantAgentIds: [...seed.participantAgentIds],
    ...(seed.bots ? { bots: seed.bots.map((bot) => ({ ...bot })) } : {}),
  };
}

function cloneMetadata(metadata: ConversationSessionMetadata): ConversationSessionMetadata {
  return {
    scope: metadata.scope,
    ...(metadata.workspaceRoot === undefined ? {} : { workspaceRoot: metadata.workspaceRoot }),
    ...(metadata.title === undefined ? {} : { title: metadata.title }),
  };
}

function cloneMessage(message: ConversationMessage): ConversationMessage {
  return {
    ...message,
    images: [...message.images],
    ...(message.parts ? { parts: message.parts.map(clonePart) } : {}),
  };
}

function clonePart(part: NonNullable<ConversationMessage["parts"]>[number]) {
  return { ...part };
}
