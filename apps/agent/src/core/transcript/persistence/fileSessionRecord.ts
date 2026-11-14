import type { ConversationSessionSummary } from "@answra/shared";
import {
  contextCompactionSchema,
  contextPruningSchema,
  contextUsageSchema,
  conversationSessionScopeSchema,
  conversationSnapshotSchema,
} from "@answra/shared/schema";
import { z } from "zod";
import type { ConversationSessionRecord } from "../memoryStore";
import { restoreContextState, restoreConversationSnapshot } from "./restore";

const checkpointSchema = z.strictObject({
  summary: z.string(),
  throughMessageId: z.string(),
  createdAt: z.string().datetime(),
  messageCount: z.number().int().nonnegative(),
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

export const fileSessionRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  conversationId: z.string(),
  scope: conversationSessionScopeSchema,
  workspaceRoot: z.string().optional(),
  title: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  snapshot: conversationSnapshotSchema,
  contextState: contextStateSchema.optional(),
  seed: seedSchema.optional(),
});

export type FileSessionRecord = z.infer<typeof fileSessionRecordSchema>;

export function parseFileSessionRecord(value: unknown): FileSessionRecord {
  return fileSessionRecordSchema.parse(value);
}

export function toSessionRecord(record: FileSessionRecord): ConversationSessionRecord {
  return {
    snapshot: restoreConversationSnapshot(record.snapshot),
    ...(record.seed ? { seed: record.seed } : {}),
    ...(record.contextState ? { contextState: restoreContextState(record.contextState) } : {}),
    metadata: {
      scope: record.scope,
      ...(record.workspaceRoot === undefined ? {} : { workspaceRoot: record.workspaceRoot }),
      ...(record.title === undefined ? {} : { title: record.title }),
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function toFileSessionRecord(record: ConversationSessionRecord): FileSessionRecord {
  if (!record.metadata) throw new Error("会话缺少 metadata，拒绝持久化");
  const { activeRunId: _activeRunId, ...snapshot } = record.snapshot;
  return {
    schemaVersion: 1,
    conversationId: record.snapshot.conversationId,
    scope: record.metadata.scope,
    ...(record.metadata.workspaceRoot === undefined
      ? {}
      : { workspaceRoot: record.metadata.workspaceRoot }),
    ...(record.metadata.title === undefined ? {} : { title: record.metadata.title }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    snapshot,
    ...(record.contextState
      ? {
          contextState: {
            ...record.contextState,
            checkpoints: record.contextState.checkpoints.map((checkpoint) => ({ ...checkpoint })),
          },
        }
      : {}),
    ...(record.seed
      ? {
          seed: {
            activeAgentId: record.seed.activeAgentId,
            participantAgentIds: [...record.seed.participantAgentIds],
            ...(record.seed.bots ? { bots: record.seed.bots.map((bot) => ({ ...bot })) } : {}),
          },
        }
      : {}),
  };
}

export function summarizeFileSessionRecord(record: FileSessionRecord): ConversationSessionSummary {
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
