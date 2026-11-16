/** 持久化加载归一化：恢复后的会话没有活动 run，未完成内容统一标为 interrupted。 */
import type {
  ContextCompactionStatus,
  ConversationMessage,
  ConversationMessagePart,
  ConversationSnapshot,
} from "@answra/shared";
import type { ContextState } from "../contextState";

export function restoreConversationSnapshot(snapshot: ConversationSnapshot): ConversationSnapshot {
  const { activeRunId: _activeRunId, ...rest } = snapshot;
  return {
    ...rest,
    eventRevision: 0,
    messages: snapshot.messages.map(restoreMessage),
    ...(snapshot.contextCompaction
      ? { contextCompaction: restoreCompaction(snapshot.contextCompaction) }
      : {}),
  };
}

export function restoreContextState(state: ContextState): ContextState {
  return {
    ...state,
    checkpoints: state.checkpoints.map((checkpoint) => ({ ...checkpoint })),
    ...(state.compaction ? { compaction: restoreCompaction(state.compaction) } : {}),
    ...(state.usageAnchor ? { usageAnchor: { ...state.usageAnchor } } : {}),
    ...(state.usage ? { usage: { ...state.usage } } : {}),
    ...(state.pruning ? { pruning: { ...state.pruning } } : {}),
    ...(state.prunedToolCallIds ? { prunedToolCallIds: [...state.prunedToolCallIds] } : {}),
  };
}

function restoreMessage(message: ConversationMessage): ConversationMessage {
  return {
    ...message,
    images: [...message.images],
    status: message.status === "streaming" ? "interrupted" : message.status,
    ...(message.parts ? { parts: message.parts.map(restorePart) } : {}),
  };
}

function restorePart(part: ConversationMessagePart): ConversationMessagePart {
  if (part.kind === "tool") {
    if (
      part.state === "input-streaming" ||
      part.state === "pending" ||
      part.state === "awaiting-approval" ||
      part.state === "running"
    ) {
      return { ...part, state: "interrupted" };
    }
    return { ...part };
  }
  if (part.state === "started" || part.state === "streaming") {
    return { ...part, state: "interrupted" };
  }
  return { ...part };
}

function restoreCompaction(compaction: ContextCompactionStatus): ContextCompactionStatus {
  return compaction.state === "started" ? { ...compaction, state: "aborted" } : { ...compaction };
}
