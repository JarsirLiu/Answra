import { z } from "zod";

/** Provider-neutral model output events normalized at the Agent boundary. */
export const agentStreamEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start") }),
  z.strictObject({ type: z.literal("text-start"), partId: z.string() }),
  z.strictObject({ type: z.literal("text-end"), partId: z.string() }),
  z.strictObject({
    type: z.literal("text-delta"),
    partId: z.string(),
    delta: z.string(),
  }),
  z.strictObject({ type: z.literal("reasoning-start"), partId: z.string() }),
  z.strictObject({ type: z.literal("reasoning-end"), partId: z.string() }),
  z.strictObject({
    type: z.literal("reasoning-delta"),
    partId: z.string(),
    delta: z.string(),
  }),
  z.strictObject({
    type: z.literal("tool-input-start"),
    toolCallId: z.string(),
    toolName: z.string(),
    title: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("tool-input-delta"),
    toolCallId: z.string(),
    delta: z.string(),
  }),
  z.strictObject({
    type: z.literal("tool-call"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("tool-result"),
    toolCallId: z.string(),
    output: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("tool-error"),
    toolCallId: z.string(),
    errorText: z.string(),
  }),
  z.strictObject({
    type: z.literal("source-url"),
    sourceId: z.string(),
    url: z.string(),
    title: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("source-document"),
    sourceId: z.string(),
    mediaType: z.string(),
    title: z.string(),
  }),
  z.strictObject({
    type: z.literal("retry"),
    kind: z.enum(["rate-limit", "server-error", "network-error"]),
    attempt: z.number().int().positive(),
    maxRetries: z.number().int().positive(),
    delayMs: z.number().int().nonnegative(),
  }),
  z.strictObject({ type: z.literal("error"), errorText: z.string() }),
]);

export type AgentStreamEvent = z.infer<typeof agentStreamEventSchema>;
