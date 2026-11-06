/** Conversation transcript 的仓储端口；只定义会话事实，不绑定内存或磁盘实现。 */
import type {
  ConversationChange,
  ConversationEvent,
  ConversationMessage,
  ConversationSnapshot,
} from "@answra/shared";
import type { RunOutcome } from "@answra/shared/schema";

/**
 * Conversation transcript 的仓储端口。
 * 约束会话消息、活动回合认领、revision 与变更补发；不指定内存或磁盘实现。
 */
export interface ConversationStore {
  create(conversationId: string): Promise<ConversationSnapshot>;
  /**
   * 仅空闲清理：会话没有活动 run 时才清空消息与 journal；仍有活动 run 时 no-op。
   * 清空必须递增 revision 并发布 snapshot change。
   */
  clear(conversationId: string): Promise<void>;
  load(conversationId: string): Promise<ConversationSnapshot>;
  beginRun(conversationId: string, runId: string, userMessage: ConversationMessage): Promise<void>;
  /** 认领最后一条用户消息并追加 assistant 占位；不存在可回复消息或已有活动 run 时不写入。 */
  beginReplyRun(conversationId: string, runId: string): Promise<ConversationMessage>;
  appendUserMessage(conversationId: string, userMessage: ConversationMessage): Promise<void>;
  /** 一次性答题的检查、清理和消息对安装必须保持为同一原子迁移。 */
  beginEphemeralRun(
    conversationId: string,
    runId: string,
    userMessage: ConversationMessage,
  ): Promise<void>;
  appendEvent(event: Omit<ConversationEvent, "revision" | "seq">): Promise<ConversationChange>;
  finishRun(conversationId: string, runId: string, outcome: RunOutcome): Promise<void>;
  readAfter(conversationId: string, revision: number): Promise<ConversationChange[]>;
  subscribe(listener: (change: ConversationChange) => void): () => void;
}
