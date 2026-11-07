import { z } from "zod";
/** Conversation transcript messages and snapshots; event facts live in events.ts. */
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
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
