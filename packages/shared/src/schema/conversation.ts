import { z } from "zod";
import { agentMessageStateSchema, agentPartStateSchema, agentToolCallStateSchema } from "./status";

/** Conversation transcript messages and snapshots; event facts live in events.ts. */
const textPartSchema = z.strictObject({
  id: z.string(),
  kind: z.literal("text"),
  text: z.string(),
  state: agentPartStateSchema,
});
const reasoningPartSchema = z.strictObject({
  id: z.string(),
  kind: z.literal("reasoning"),
  text: z.string(),
  state: agentPartStateSchema,
});
const toolPartSchema = z.strictObject({
  id: z.string(),
  kind: z.literal("tool"),
  toolCallId: z.string(),
  toolName: z.string(),
  title: z.string().optional(),
  state: agentToolCallStateSchema,
  input: z.unknown().optional(),
  inputText: z.string().optional(),
  output: z.unknown().optional(),
  errorText: z.string().optional(),
});
export const conversationMessagePartSchema = z.discriminatedUnion("kind", [
  textPartSchema,
  reasoningPartSchema,
  toolPartSchema,
]);
export const conversationMessageSchema = z.strictObject({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  images: z.array(z.strictObject({ name: z.string(), dataUrl: z.string() })),
  status: agentMessageStateSchema,
  parts: z.array(conversationMessagePartSchema).optional(),
  reasoning: z.string().optional(),
});

export const conversationSnapshotSchema = z.strictObject({
  conversationId: z.string(),
  /** Conversation event revision before the most recent run; UI replays that run from the event store. */
  eventRevision: z.number().int().nonnegative(),
  messages: z.array(conversationMessageSchema),
  activeRunId: z.string().optional(),
});

/** One persisted content event; seq is per run and revision is per session. */
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationMessagePart = z.infer<typeof conversationMessagePartSchema>;
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
