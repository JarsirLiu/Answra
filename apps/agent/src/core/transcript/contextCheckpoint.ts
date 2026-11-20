/** 一次已完成摘要的边界；summary 是 synthetic user message 的正文。 */
import type { ConversationMessage } from "@answra/shared";

export interface ContextCheckpoint {
  summary: string;
  /** 摘要覆盖的最后一条 transcript 消息 ID。 */
  throughMessageId: string;
  createdAt: string;
  /** 摘要覆盖的累计消息数，用于诊断和后续归档。 */
  messageCount: number;
  /** 摘要后仍以原始消息投影的最近用户消息；旧 checkpoint 没有该字段。 */
  retainedUserMessages?: ConversationMessage[];
  /** 手动压缩附带的一次性摘要指令；自动压缩不产生。 */
  instructions?: string;
}

export function cloneContextCheckpoint(checkpoint: ContextCheckpoint): ContextCheckpoint {
  return {
    ...checkpoint,
    ...(checkpoint.retainedUserMessages
      ? { retainedUserMessages: checkpoint.retainedUserMessages.map(cloneMessage) }
      : {}),
  };
}

export function latestCheckpoint(
  state: { checkpoints: readonly ContextCheckpoint[] } | undefined,
): ContextCheckpoint | undefined {
  return state?.checkpoints.at(-1);
}

/** 返回检查点之后的消息；检查点引用的消息已不存在时返回 undefined。 */
export function messagesAfterCheckpoint(
  messages: readonly ConversationMessage[],
  checkpoint: ContextCheckpoint | undefined,
): ConversationMessage[] | undefined {
  if (!checkpoint) return [...messages];
  const index = messages.findIndex((message) => message.id === checkpoint.throughMessageId);
  return index < 0 ? undefined : messages.slice(index + 1);
}

function cloneMessage(message: ConversationMessage): ConversationMessage {
  return {
    ...message,
    images: message.images.map((image) => ({ ...image })),
    ...(message.parts ? { parts: message.parts.map((part) => ({ ...part })) } : {}),
  };
}
