import { z } from "zod";

/** App-owned stream event. This is the only event shape persisted and sent over IPC. */
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
  z.strictObject({ type: z.literal("error"), errorText: z.string() }),
]);

export type AgentStreamEvent = z.infer<typeof agentStreamEventSchema>;

/** Terminal state of one model run. */
export const runOutcomeSchema = z.enum(["completed", "failed", "aborted", "superseded"]);

export type RunOutcome = z.infer<typeof runOutcomeSchema>;
