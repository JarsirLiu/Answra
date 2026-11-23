/**
 * 会话条目的跨包契约：一行一条**写入即终态**的对话事实。
 *
 * 只定义形状与取值，不定义写入时机、`seq` 分配、迁移或渲染；把条目折回消息见 `fold.ts`。
 * `kind` 只在 `payload` 里出现一次；SQLite 适配器用它填 `kind` 列，读出时校验两处一致。
 */
import { z } from "zod";
import { conversationImageSchema } from "../conversation";
import { agentFinishReasonSchema, agentUsageSchema, turnFinishReasonSchema } from "../status";

/** 条目种类；前五种是用户看得到的对话内容，`turn-end` 是 Turn 收口。 */
export const sessionItemKindSchema = z.enum([
  "user",
  "text",
  "reasoning",
  "tool-call",
  "tool-result",
  "turn-end",
]);

/**
 * 条目终态；没有 `running`。
 *
 * 运行中的状态一律由 `sessions.open_turn_id` 加折叠派生，不写进条目。
 */
export const sessionItemStatusSchema = z.enum(["complete", "interrupted", "failed"]);

/** 用户提交的输入；图片沿用消息里的内联形状，外置属于独立变更。 */
const userItemPayloadSchema = z.strictObject({
  kind: z.literal("user"),
  text: z.string(),
  images: z.array(conversationImageSchema),
});

/** 一段已结算的正文；写入时正文已完整，不存在「先写半截再补」。 */
const textItemPayloadSchema = z.strictObject({
  kind: z.literal("text"),
  text: z.string(),
});

const reasoningItemPayloadSchema = z.strictObject({
  kind: z.literal("reasoning"),
  text: z.string(),
});

/** 模型请求的一次工具调用；执行结果在独立的 `tool-result` 条目里。 */
const toolCallItemPayloadSchema = z.strictObject({
  kind: z.literal("tool-call"),
  toolCallId: z.string(),
  toolName: z.string(),
  title: z.string().optional(),
  input: z.unknown().optional(),
  inputText: z.string().optional(),
});

/** 工具调用的唯一结果；`outcome` 决定折出的 part 是完成、失败还是被拒绝。行状态恒为 `complete`。 */
const toolResultItemPayloadSchema = z.strictObject({
  kind: z.literal("tool-result"),
  toolCallId: z.string(),
  outcome: z.enum(["output", "error", "denied"]),
  output: z.unknown().optional(),
  errorText: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

/** 中断原因；三种来源共用 `interrupted` 状态，靠这里区分。 */
export const sessionItemInterruptionSchema = z.strictObject({
  reason: z.enum(["cancelled", "process-exit", "migrated"]),
  at: z.string().datetime(),
});

/** 一个 Turn 的收口汇总；吸收原来的运行表字段，不再单独建运行表。 */
const turnEndItemPayloadSchema = z.strictObject({
  kind: z.literal("turn-end"),
  /** 最后一步 provider 的终因（stop / length / error）；与 Turn 归因不是同一件事。 */
  finishReason: agentFinishReasonSchema.optional(),
  /** Turn 归因（cancelled / handoff-failed / context-exhausted 等）；由调度器写入。 */
  reason: turnFinishReasonSchema.optional(),
  stepCount: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  usage: agentUsageSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  errorText: z.string().optional(),
  interruption: sessionItemInterruptionSchema.optional(),
});

export const sessionItemPayloadSchema = z.discriminatedUnion("kind", [
  userItemPayloadSchema,
  textItemPayloadSchema,
  reasoningItemPayloadSchema,
  toolCallItemPayloadSchema,
  toolResultItemPayloadSchema,
  turnEndItemPayloadSchema,
]);

export const sessionItemSchema = z
  .strictObject({
    /** 会话内连续递增，由 `sessions.next_seq` 在同一事务内分配。 */
    seq: z.number().int().positive(),
    /** 由领域 id 派生，见本文件底部的派生函数。 */
    itemId: z.string(),
    status: sessionItemStatusSchema,
    createdAt: z.string().datetime(),
    /** Turn 归属；迁移来的无 Turn 历史消息为 NULL。 */
    turnId: z.string().optional(),
    /** part 类条目的所属消息；`user` 与 `turn-end` 不携带。 */
    messageId: z.string().optional(),
    /** assistant/tool 条目的作者 Bot。 */
    authorAgentId: z.string().optional(),
    /** 非空表示只对该 Bot 可见（交接消息的接收方）。 */
    audienceAgentId: z.string().optional(),
    payload: sessionItemPayloadSchema,
  })
  .superRefine((item, context) => {
    const fail = (message: string): void => {
      context.addIssue({ code: "custom", message });
    };
    if (item.payload.kind === "turn-end") {
      if (item.turnId === undefined) fail("turn-end 条目必须携带 turnId");
      if (item.messageId !== undefined) fail("turn-end 条目不携带 messageId");
      if (item.status === "interrupted" && item.payload.interruption === undefined)
        fail("interrupted 的 turn-end 必须说明中断原因");
      return;
    }
    if (item.payload.kind === "user") {
      if (item.messageId !== undefined) fail("user 条目不携带 messageId，消息 id 就是 itemId");
      if (item.authorAgentId !== undefined) fail("user 条目没有作者 Bot");
      if (item.status !== "complete") fail("user 条目写入即 complete");
      return;
    }
    if (item.messageId === undefined) fail(`${item.payload.kind} 条目必须携带 messageId`);
    if (item.payload.kind === "tool-call" && item.status !== "complete")
      fail("tool-call 条目写入即 complete；执行结果由 tool-result 表达");
    if (item.payload.kind === "tool-result" && item.status !== "complete")
      fail("tool-result 条目写入即 complete；输出/失败/拒绝由 outcome 表达");
    if (item.audienceAgentId !== undefined && item.authorAgentId === undefined)
      fail("带接收方的条目必须同时有作者 Bot");
  });

export type SessionItemKind = z.infer<typeof sessionItemKindSchema>;
export type SessionItemStatus = z.infer<typeof sessionItemStatusSchema>;
export type SessionItemInterruption = z.infer<typeof sessionItemInterruptionSchema>;
export type SessionItemPayload = z.infer<typeof sessionItemPayloadSchema>;
export type SessionItem = z.infer<typeof sessionItemSchema>;

/**
 * 工具结果的条目 id：同一个 `toolCallId` 的 call 与 result 不会互相覆盖，
 * 且 `tool-execution-finished` 与 `tool-result` 各写一次时命中同一条唯一约束。
 */
export function toolResultItemId(toolCallId: string): string {
  return `${toolCallId}:result`;
}

/** Turn 收口的条目 id；与 `turnId` 一一对应，重复收口是 no-op。 */
export function turnEndItemId(turnId: string): string {
  return `${turnId}:end`;
}
