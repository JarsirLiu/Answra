/** 持久化加载归一化：恢复后的会话没有活动 Turn，未完成内容统一标为 interrupted。 */
import type {
  ContextCompactionStatus,
  ConversationMessage,
  ConversationMessagePart,
  ConversationSnapshot,
} from "@answra/shared";
import { cloneContextCheckpoint } from "../contextCheckpoint";
import type { ContextState } from "../contextState";

/** 旧记录可能带 `activeRunId`；恢复时连同活动 Turn 一起丢弃。 */
export type PersistedConversationSnapshot = Omit<
  ConversationSnapshot,
  "activeTurnId" | "activeMessageId" | "lastSeq"
> & {
  activeRunId?: string;
  activeTurnId?: string;
  activeMessageId?: string;
  lastSeq?: number;
};

export function restoreConversationSnapshot(
  persisted: PersistedConversationSnapshot,
): ConversationSnapshot {
  const {
    activeRunId: _activeRunId,
    activeTurnId: _activeTurnId,
    activeMessageId: _activeMessageId,
    lastSeq: _lastSeq,
    ...snapshot
  } = persisted;
  return {
    ...snapshot,
    // durable 游标是运行期状态：恢复后由条目末尾重新 seed，不能沿用旧进程的值。
    lastSeq: 0,
    messages: snapshot.messages.map(restoreMessage),
    ...(snapshot.contextCompaction
      ? { contextCompaction: restoreCompaction(snapshot.contextCompaction) }
      : {}),
  };
}

export function restoreContextState(state: ContextState): ContextState {
  return {
    ...state,
    checkpoints: state.checkpoints.map(cloneContextCheckpoint),
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
