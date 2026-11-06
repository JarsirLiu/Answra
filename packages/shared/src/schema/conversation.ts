import { z } from "zod";
import { runOutcomeSchema } from "./execution";
import { agentStreamEventSchema } from "./stream";

/** Persisted conversation messages, snapshots, events, and change notifications. */
export const conversationMessageSchema = z.strictObject({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  images: z.array(z.strictObject({ name: z.string(), dataUrl: z.string() })),
  status: z.enum(["complete", "streaming", "interrupted", "failed"]),
});

export const conversationSnapshotSchema = z.strictObject({
  conversationId: z.string(),
  revision: z.number().int().nonnegative(),
  messages: z.array(conversationMessageSchema),
  activeRunId: z.string().optional(),
});

/** One persisted content event; seq is per run and revision is per session. */
export const conversationEventSchema = z.strictObject({
  conversationId: z.string(),
  runId: z.string(),
  seq: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  stream: agentStreamEventSchema,
});

export const conversationChangeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("snapshot"), snapshot: conversationSnapshotSchema }),
  z.strictObject({
    type: z.literal("messages-appended"),
    conversationId: z.string(),
    revision: z.number().int().nonnegative(),
    messages: z.array(conversationMessageSchema),
    activeRunId: z.string().optional(),
  }),
  z.strictObject({ type: z.literal("event"), event: conversationEventSchema }),
  z.strictObject({
    type: z.literal("run-finished"),
    conversationId: z.string(),
    revision: z.number().int().nonnegative(),
    runId: z.string(),
    outcome: runOutcomeSchema,
    message: conversationMessageSchema,
  }),
]);

export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
export type ConversationEvent = z.infer<typeof conversationEventSchema>;
export type ConversationChange = z.infer<typeof conversationChangeSchema>;
